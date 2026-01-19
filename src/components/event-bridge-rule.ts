import * as aws from "@pulumi/aws";
import { LambdaComponent } from "./lambda";
import { getDefaultTags } from "../utils/tags";

export interface EventBridgeRuleConfig {
  readonly name: string;
  readonly prefix: string;
  readonly scheduleExpression: string;
  readonly lambdaFunction: LambdaComponent;
  readonly enabled?: boolean;
  readonly description?: string;
}

/**
 * Reusable EventBridge rule component for scheduled Lambda function invocations.
 */
export class EventBridgeRule {
  public readonly rule: aws.cloudwatch.EventRule;
  public readonly target: aws.cloudwatch.EventTarget;

  constructor(config: EventBridgeRuleConfig) {
    const {
      name,
      prefix,
      scheduleExpression,
      lambdaFunction,
      enabled = true,
      description,
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Create EventBridge rule
    this.rule = new aws.cloudwatch.EventRule(resourceName, {
      name: resourceName,
      scheduleExpression: scheduleExpression,
      state: enabled ? "ENABLED" : "DISABLED",
      description: description,
      tags: getDefaultTags(prefix),
    });

    // Grant EventBridge permission to invoke Lambda
    new aws.lambda.Permission(`${resourceName}-eventbridge-invoke`, {
      action: "lambda:InvokeFunction",
      function: lambdaFunction.function.name,
      principal: "events.amazonaws.com",
      sourceArn: this.rule.arn,
    });

    // Create target
    this.target = new aws.cloudwatch.EventTarget(`${resourceName}-target`, {
      rule: this.rule.name,
      arn: lambdaFunction.function.arn,
    });
  }
}

