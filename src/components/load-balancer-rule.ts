import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { getDefaultTags } from "../utils/tags";

/**
 * Exported AWS types for listener rule conditions and actions.
 * Use these types when configuring rules to ensure type safety.
 */
export type ListenerRuleCondition = aws.types.input.lb.ListenerRuleCondition;
export type ListenerRuleAction = aws.types.input.lb.ListenerRuleAction;

export interface LoadBalancerRuleConfig {
  readonly name: string;
  readonly prefix: string;
  readonly loadBalancerArn: pulumi.Input<string>;
  readonly listenerArn: pulumi.Input<string>;
  readonly targetGroup: {
    readonly port: number;
    readonly protocol: "HTTP" | "HTTPS";
    readonly targetType: "ip" | "instance" | "lambda";
    readonly healthCheck?: {
      readonly enabled?: boolean;
      readonly healthyThresholdCount?: number;
      readonly unhealthyThresholdCount?: number;
      readonly timeoutSeconds?: number;
      readonly intervalSeconds?: number;
      readonly path?: string;
      readonly matcher?: string;
    };
    readonly deregistrationDelay?: number;
    readonly stickiness?: {
      readonly enabled?: boolean;
      readonly type?: string;
      readonly cookieDuration?: number;
    };
    readonly vpcId: pulumi.Input<string>;
  };
  readonly rule?: {
    readonly priority?: number;
    readonly conditions?: pulumi.Input<pulumi.Input<aws.types.input.lb.ListenerRuleCondition>[]>;
    readonly actions: pulumi.Input<pulumi.Input<aws.types.input.lb.ListenerRuleAction>[]>;
  };
  readonly tags?: Record<string, string>;
}

/**
 * Reusable load balancer rule component for Application Load Balancers (ALB).
 * Creates target groups and listener rules for connecting ECS services to existing ALB listeners.
 * Supports HTTP and HTTPS protocols only.
 */
export class LoadBalancerRuleComponent {
  public readonly targetGroup: aws.lb.TargetGroup;
  public readonly targetGroupArn: pulumi.Output<string>;
  public listenerRule?: aws.lb.ListenerRule;
  public readonly listener: aws.lb.Listener;

  constructor(config: LoadBalancerRuleConfig) {
    const {
      name,
      prefix,
      loadBalancerArn,
      listenerArn,
      targetGroup,
      rule,
      tags = {},
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Create target group
    const targetGroupConfig: aws.lb.TargetGroupArgs = {
      name: resourceName,
      port: targetGroup.port,
      protocol: targetGroup.protocol,
      targetType: targetGroup.targetType,
      vpcId: targetGroup.vpcId,
      deregistrationDelay: targetGroup.deregistrationDelay,
      tags: getDefaultTags(prefix, tags),
    };

    // Add health check configuration
    if (targetGroup.healthCheck) {
      targetGroupConfig.healthCheck = {
        enabled: targetGroup.healthCheck.enabled ?? true,
        healthyThreshold: targetGroup.healthCheck.healthyThresholdCount ?? 2,
        unhealthyThreshold: targetGroup.healthCheck.unhealthyThresholdCount ?? 2,
        timeout: targetGroup.healthCheck.timeoutSeconds ?? 5,
        interval: targetGroup.healthCheck.intervalSeconds ?? 30,
        path: targetGroup.healthCheck.path,
        matcher: targetGroup.healthCheck.matcher,
        protocol: targetGroup.protocol,
      };
    } else {
      // Default health check for HTTP/HTTPS
      targetGroupConfig.healthCheck = {
        enabled: true,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
        timeout: 5,
        interval: 30,
        path: "/",
        protocol: targetGroup.protocol,
      };
    }

    // Add stickiness configuration
    if (targetGroup.stickiness) {
      targetGroupConfig.stickiness = {
        enabled: targetGroup.stickiness.enabled ?? false,
        type: targetGroup.stickiness.type ?? "lb_cookie",
        cookieDuration: targetGroup.stickiness.cookieDuration ?? 86400,
      };
    }

    this.targetGroup = new aws.lb.TargetGroup(`${resourceName}-tg`, targetGroupConfig);
    this.targetGroupArn = this.targetGroup.arn;

    // Reference existing listener
    this.listener = aws.lb.Listener.get(
      `${resourceName}-listener`,
      listenerArn
    );

    // Create listener rule if conditions and actions are provided
    if (rule && rule.conditions && rule.actions) {
      this.listenerRule = new aws.lb.ListenerRule(`${resourceName}-rule`, {
        listenerArn: listenerArn,
        priority: rule.priority,
        conditions: rule.conditions,
        actions: rule.actions,
        tags: getDefaultTags(prefix, tags),
      });
    }
  }

  /**
   * Helper method to create a simple path-based rule for ALB
   * @param removePathPrefix - If provided, removes this prefix from the path before forwarding.
   *                           For example, if pathPattern is "/dev/*" and removePathPrefix is "/dev",
   *                           a request to "/dev/api/users" will be forwarded as "/api/users"
   *                           Uses AWS ALB's url-rewrite transform feature (available as of Oct 2025)
   */
  static createPathRule(config: {
    name: string;
    prefix: string;
    loadBalancerArn: pulumi.Input<string>;
    listenerArn: pulumi.Input<string>;
    pathPattern: string;
    targetGroup: LoadBalancerRuleConfig["targetGroup"];
    priority?: number;
    removePathPrefix?: string;
    tags?: Record<string, string>;
  }): LoadBalancerRuleComponent {
    // Create component first to get target group ARN
    const component = new LoadBalancerRuleComponent({
      name: config.name,
      prefix: config.prefix,
      loadBalancerArn: config.loadBalancerArn,
      listenerArn: config.listenerArn,
      targetGroup: config.targetGroup,
      tags: config.tags,
    });

    // Build actions array
    const actions: aws.types.input.lb.ListenerRuleAction[] = [
      {
        type: "forward",
        forward: {
          targetGroups: [
            {
              arn: component.targetGroupArn,
              weight: 1,
            },
          ],
        },
      },
    ];

    // Build transforms array if path prefix removal is requested
    let transforms: aws.types.input.lb.ListenerRuleTransform[] | undefined;
    if (config.removePathPrefix) {
      // Normalize the prefix to ensure it starts with / and doesn't end with /
      let normalizedPrefix = config.removePathPrefix.trim();
      if (!normalizedPrefix.startsWith("/")) {
        normalizedPrefix = "/" + normalizedPrefix;
      }
      // Remove trailing slash if present (except for root)
      if (normalizedPrefix.length > 1 && normalizedPrefix.endsWith("/")) {
        normalizedPrefix = normalizedPrefix.slice(0, -1);
      }

      // Create regex pattern to match the prefix and capture everything after it
      // For "/dev", the regex will be "^/dev/(.*)" to match "/dev/something" and capture "something"
      const regexPattern = `^${normalizedPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.*)`;
      const replacementPattern = "/$1";

      transforms = [
        {
          type: "url-rewrite",
          urlRewriteConfig: {
            rewrite: {
              regex: regexPattern,
              replace: replacementPattern,
            },
          },
        },
      ];
    }

    // Create listener rule with resolved target group ARN using proper AWS types
    const listenerRuleConfig: aws.lb.ListenerRuleArgs = {
      listenerArn: config.listenerArn,
      priority: config.priority,
      conditions: [
        {
          pathPattern: {
            values: [config.pathPattern],
          },
        },
      ],
      actions: actions,
      tags: getDefaultTags(config.prefix, config.tags),
    };

    // Add transforms if path prefix removal is configured
    if (transforms) {
      listenerRuleConfig.transforms = transforms;
    }

    const listenerRule = new aws.lb.ListenerRule(`${config.prefix}-${config.name}-rule`, listenerRuleConfig);

    // Set listener rule on component
    component.listenerRule = listenerRule;

    return component;
  }
}
