import * as aws from "@pulumi/aws";
import { LambdaComponent } from "./lambda";
import { SqsComponent } from "./sqs";
import { getDefaultTags } from "../utils/tags";

export interface SqsEventSourceMappingConfig {
  readonly name: string;
  readonly prefix: string;
  readonly lambdaFunction: LambdaComponent;
  readonly sqsQueue: SqsComponent;
  readonly batchSize?: number;
  readonly maximumConcurrency?: number;
  readonly enabled?: boolean;
}

/**
 * Reusable SQS event source mapping component for triggering Lambda functions from SQS queues.
 */
export class SqsEventSourceMapping {
  public readonly eventSourceMapping: aws.lambda.EventSourceMapping;

  constructor(config: SqsEventSourceMappingConfig) {
    const {
      name,
      prefix,
      lambdaFunction,
      sqsQueue,
      batchSize = 10,
      maximumConcurrency = 10,
      enabled = true,
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Grant SQS permission to invoke Lambda
    new aws.lambda.Permission(`${resourceName}-sqs-invoke`, {
      action: "lambda:InvokeFunction",
      function: lambdaFunction.function.name,
      principal: "sqs.amazonaws.com",
      sourceArn: sqsQueue.queueArn,
    });

    // Create event source mapping
    this.eventSourceMapping = new aws.lambda.EventSourceMapping(resourceName, {
      eventSourceArn: sqsQueue.queueArn,
      functionName: lambdaFunction.function.arn,
      batchSize: batchSize,
      scalingConfig: {
        maximumConcurrency: maximumConcurrency,
      },
      enabled: enabled,
      tags: getDefaultTags(prefix),
    });
  }
}

