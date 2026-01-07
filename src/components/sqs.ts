import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface SqsComponentConfig {
  readonly name: string;
  readonly prefix: string;
  readonly visibilityTimeoutSeconds?: number;
  readonly messageRetentionSeconds?: number;
  readonly maxReceiveCount?: number;
  readonly deadLetterQueue?: boolean;
  readonly fifo?: boolean;
  readonly contentBasedDeduplication?: boolean;
  readonly tags?: Record<string, string>;
}

/**
 * Reusable SQS queue component with common configurations.
 */
export class SqsComponent {
  public readonly queue: aws.sqs.Queue;
  public readonly queueUrl: pulumi.Output<string>;
  public readonly queueArn: pulumi.Output<string>;
  public readonly deadLetterQueue?: aws.sqs.Queue;
  public readonly deadLetterQueueUrl?: pulumi.Output<string>;
  public readonly deadLetterQueueArn?: pulumi.Output<string>;

  constructor(config: SqsComponentConfig) {
    const {
      name,
      prefix,
      visibilityTimeoutSeconds = 30,
      messageRetentionSeconds = 345600, // 4 days
      maxReceiveCount = 3,
      deadLetterQueue: enableDeadLetterQueue = false,
      fifo = false,
      contentBasedDeduplication = false,
      tags = {},
    } = config;

    const resourceName = `${prefix}-${name}`;
    const queueName = fifo ? `${resourceName}.fifo` : resourceName;

    // Create dead letter queue if enabled
    if (enableDeadLetterQueue) {
      const dlqName = fifo ? `${resourceName}-dlq.fifo` : `${resourceName}-dlq`;
      const dlqResourceName = `${prefix}-${name}-dlq`;
      this.deadLetterQueue = new aws.sqs.Queue(dlqResourceName, {
        name: dlqName,
        messageRetentionSeconds: messageRetentionSeconds,
        ...(fifo ? { fifoQueue: true } : {}),
        ...(fifo && contentBasedDeduplication ? { contentBasedDeduplication: true } : {}),
        tags: {
          ...tags,
          ManagedBy: "Pulumi",
          Type: "DeadLetterQueue",
        },
      });

      this.deadLetterQueueUrl = this.deadLetterQueue.url;
      this.deadLetterQueueArn = this.deadLetterQueue.arn;
    }

    // Create main queue
    const redrivePolicy = this.deadLetterQueue
      ? pulumi
          .all([this.deadLetterQueue.arn])
          .apply(([dlqArn]) =>
            JSON.stringify({
              deadLetterTargetArn: dlqArn,
              maxReceiveCount: maxReceiveCount,
            })
          )
      : undefined;

    this.queue = new aws.sqs.Queue(resourceName, {
      name: queueName,
      visibilityTimeoutSeconds: visibilityTimeoutSeconds,
      messageRetentionSeconds: messageRetentionSeconds,
      redrivePolicy: redrivePolicy,
      ...(fifo ? { fifoQueue: true } : {}),
      ...(fifo && contentBasedDeduplication ? { contentBasedDeduplication: true } : {}),
      tags: {
        ...tags,
        ManagedBy: "Pulumi",
      },
    });

    this.queueUrl = this.queue.url;
    this.queueArn = this.queue.arn;
  }
}

