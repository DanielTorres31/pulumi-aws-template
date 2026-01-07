import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { EventBridgeRule, LambdaComponent, SqsEventSourceMapping } from "../components";
import { QueueStack } from "./queue-stack";

export interface LambdaStackConfig {
    readonly prefix: string;
    readonly queueStack: QueueStack;
}

export class LambdaStack {
    public readonly sqsExampleLambda: LambdaComponent;
    public readonly eventBridgeSQSExampleLambda: LambdaComponent;

    constructor(config: LambdaStackConfig) {
        const { prefix, queueStack } = config;

        this.sqsExampleLambda = this.createExampleSQSLambda(prefix);
        this.eventBridgeSQSExampleLambda = this.createExampleSQSEventBridgeLambda(prefix, queueStack);

        // Create triggers
        this.createTriggers(prefix, queueStack);
    }

    private createExampleSQSLambda(prefix: string) {
        const name = "sqs-example-handler";
        const role = LambdaComponent.createExecutionRole({
            name: `${name}-role`,
            prefix: prefix,
        });

        // Attach SQS queue execution policy
        new aws.iam.RolePolicyAttachment(`${prefix}-${name}-sqs-basic-execution`, {
            role: role.name,
            policyArn: aws.iam.ManagedPolicy.AWSLambdaSQSQueueExecutionRole,
        });

        return new LambdaComponent({
            name: `${name}-handler`,
            prefix: prefix,
            handler: "handler.lambdaHandler",
            role: role,
            timeout: 600, // 10 minutes
            memorySize: 2048,
            build: {
                handlerFile: "src/handlers/sqs-example-handler.handler.ts",
                handlerExport: "lambdaHandler",
                sourceDir: "../api",
                buildDir: ".pulumi/lambda-build-sqs-example-handler",
            }
        });
    }

    private createExampleSQSEventBridgeLambda(prefix: string, queueStack: QueueStack) {
        const name = "event-bridge-example-handler";

        // Create policy document for SQS publish permission
        const role = LambdaComponent.createExecutionRole({
            name: `${name}-role`,
            prefix: prefix,
            additionalPolicies: pulumi.all([queueStack.exampleQueue.queueArn]).apply(([queueArn]) => ({
                Version: "2012-10-17" as const,
                Statement: [
                    {
                        Effect: "Allow" as const,
                        Action: [
                            "sqs:SendMessage",
                            "sqs:GetQueueAttributes",
                        ],
                        Resource: queueArn,
                    },
                ],
            })),
        });

        return new LambdaComponent({
            name: `${name}-handler`,
            prefix: prefix,
            handler: "handler.lambdaHandler",
            role: role,
            timeout: 60, // 1 minute
            memorySize: 128,
            build: {
                handlerFile: "src/handlers/event-bridge-example-handler.handler.ts",
                handlerExport: "lambdaHandler",
                sourceDir: "../api",
                buildDir: ".pulumi/lambda-build-event-bridge-example-handler",
            }
        });
    }

    private createTriggers(prefix: string, queueStack: QueueStack) {
        // Create SQS trigger for example
        new SqsEventSourceMapping({
            name: "example-trigger",
            prefix: prefix,
            lambdaFunction: this.sqsExampleLambda.function,
            sqsQueue: queueStack.exampleQueue,
            batchSize: 1,
            maximumConcurrency: 50,
        });

        // Create EventBridge trigger for example (every minute)
        new EventBridgeRule({
            name: "example-schedule",
            prefix: prefix,
            scheduleExpression: "cron(0/5 * * * ? *)",
            lambdaFunction: this.eventBridgeSQSExampleLambda.function,
        });
    }
}