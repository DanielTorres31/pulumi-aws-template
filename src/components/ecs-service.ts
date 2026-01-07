import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface ContainerDefinition {
  readonly name: string;
  readonly image: pulumi.Input<string>;
  readonly cpu?: number;
  readonly memory?: number;
  readonly memoryReservation?: number;
  readonly essential?: boolean;
  readonly portMappings?: Array<{
    readonly containerPort: number;
    readonly hostPort?: number;
    readonly protocol?: string;
  }>;
  readonly environment?: Array<{
    readonly name: string;
    readonly value: string;
  }>;
  readonly secrets?: Array<{
    readonly name: string;
    readonly valueFrom: string;
  }>;
  readonly logConfiguration?: {
    readonly logDriver: string;
    readonly options?: Record<string, pulumi.Input<string>>;
  };
  readonly command?: string[];
}

export interface EcsServiceConfig {
  readonly name: string;
  readonly prefix: string;
  readonly clusterName: string;
  readonly containerDefinitions: ContainerDefinition[];
  readonly taskExecutionRoleArn?: pulumi.Input<string>;
  readonly taskRoleArn?: pulumi.Input<string>;
  readonly cpu?: string;
  readonly memory?: string;
  readonly requiresCompatibilities?: string[];
  readonly networkMode?: string;
  readonly desiredCount?: number;
  readonly launchType?: string;
  readonly subnets: pulumi.Input<string[]>;
  readonly securityGroups: pulumi.Input<string[]>;
  readonly enableExecuteCommand?: boolean;
  readonly healthCheckGracePeriodSeconds?: number;
  readonly loadBalancers?: Array<{
    readonly targetGroupArn: pulumi.Input<string>;
    readonly containerName: string;
    readonly containerPort: number;
  }>;
  readonly tags?: Record<string, string>;
}

/**
 * Reusable ECS service component that references an existing cluster.
 * Creates a task definition and ECS service on the specified cluster.
 */
export class EcsService {
  public readonly cluster: aws.ecs.Cluster;
  public readonly taskDefinition: aws.ecs.TaskDefinition;
  public readonly service: aws.ecs.Service;
  public readonly taskDefinitionArn: pulumi.Output<string>;
  public readonly serviceName: pulumi.Output<string>;

  constructor(config: EcsServiceConfig) {
    const {
      name,
      prefix,
      clusterName,
      containerDefinitions,
      taskExecutionRoleArn,
      taskRoleArn,
      cpu = "256",
      memory = "512",
      requiresCompatibilities = ["FARGATE"],
      networkMode = "awsvpc",
      desiredCount = 1,
      launchType = "FARGATE",
      subnets,
      securityGroups,
      enableExecuteCommand = false,
      healthCheckGracePeriodSeconds,
      loadBalancers,
      tags = {},
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Reference existing cluster by name
    // Pulumi will use the existing cluster without creating a new one
    this.cluster = aws.ecs.Cluster.get(`${resourceName}-cluster`, clusterName);

    // Create task definition
    // Convert container definitions to JSON string format
    // Note: image can be a pulumi.Input<string>, so we use jsonStringify which handles Outputs
    const containerDefsArray = containerDefinitions.map((def) => ({
      name: def.name,
      image: def.image,
      cpu: def.cpu,
      memory: def.memory,
      memoryReservation: def.memoryReservation,
      essential: def.essential !== false,
      portMappings: def.portMappings?.map((pm) => ({
        containerPort: pm.containerPort,
        hostPort: pm.hostPort ?? pm.containerPort,
        protocol: pm.protocol ?? "tcp",
      })),
      environment: def.environment,
      secrets: def.secrets,
      logConfiguration: def.logConfiguration,
      command: def.command,
    }));

    const containerDefsJson = pulumi.jsonStringify(containerDefsArray);

    this.taskDefinition = new aws.ecs.TaskDefinition(`${resourceName}-task`, {
      family: `${resourceName}-task`,
      networkMode: networkMode,
      requiresCompatibilities: requiresCompatibilities,
      cpu: cpu,
      memory: memory,
      executionRoleArn: taskExecutionRoleArn,
      taskRoleArn: taskRoleArn,
      containerDefinitions: containerDefsJson,
      tags: {
        ...tags,
        ManagedBy: "Pulumi",
      },
    });

    this.taskDefinitionArn = this.taskDefinition.arn;

    // Create ECS service
    const serviceConfig: aws.ecs.ServiceArgs = {
      name: resourceName,
      cluster: this.cluster.arn,
      taskDefinition: this.taskDefinition.arn,
      desiredCount: desiredCount,
      launchType: launchType,
      networkConfiguration: {
        subnets: subnets,
        securityGroups: securityGroups,
      },
      enableExecuteCommand: enableExecuteCommand,
      ...(healthCheckGracePeriodSeconds !== undefined
        ? { healthCheckGracePeriodSeconds: healthCheckGracePeriodSeconds }
        : {}),
      ...(loadBalancers && loadBalancers.length > 0
        ? {
            loadBalancers: loadBalancers.map((lb) => ({
              targetGroupArn: lb.targetGroupArn,
              containerName: lb.containerName,
              containerPort: lb.containerPort,
            })),
          }
        : {}),
      tags: {
        ...tags,
        ManagedBy: "Pulumi",
      },
    };

    this.service = new aws.ecs.Service(`${resourceName}-service`, serviceConfig);
    this.serviceName = this.service.name;
  }

  /**
   * Create a basic task execution role for ECS tasks.
   * This role allows ECS to pull images from ECR and write logs to CloudWatch.
   */
  static createTaskExecutionRole(
    { name, prefix, additionalPolicies }: {
      name: string;
      prefix: string;
      additionalPolicies?: pulumi.Input<aws.iam.PolicyDocument>;
    }
  ): aws.iam.Role {
    const resourceName = `${prefix}-${name}`;

    const role = new aws.iam.Role(`${resourceName}-role`, {
      name: resourceName,
      assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // Attach AWS managed policy for ECS task execution
    new aws.iam.RolePolicyAttachment(`${resourceName}-execution-policy`, {
      role: role.name,
      policyArn: aws.iam.ManagedPolicy.AmazonECSTaskExecutionRolePolicy,
    });

    // Add additional policies if provided
    if (additionalPolicies) {
      const policyJson = pulumi.all([additionalPolicies]).apply(([policy]) =>
        JSON.stringify(policy)
      );

      new aws.iam.RolePolicy(`${resourceName}-additional-policy`, {
        role: role.name,
        policy: policyJson,
      });
    }

    return role;
  }

  /**
   * Create a task role for ECS tasks.
   * This role is used by the application running in the container.
   */
  static createTaskRole(
    { name, prefix, additionalPolicies }: {
      name: string;
      prefix: string;
      additionalPolicies?: pulumi.Input<aws.iam.PolicyDocument>;
    }
  ): aws.iam.Role {
    const resourceName = `${prefix}-${name}`;

    const role = new aws.iam.Role(`${resourceName}-role`, {
      name: resourceName,
      assumeRolePolicy: pulumi.jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: "ecs-tasks.amazonaws.com",
            },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    // Add additional policies if provided
    if (additionalPolicies) {
      const policyJson = pulumi.all([additionalPolicies]).apply(([policy]) =>
        JSON.stringify(policy)
      );

      new aws.iam.RolePolicy(`${resourceName}-additional-policy`, {
        role: role.name,
        policy: policyJson,
      });
    }

    return role;
  }
}

