import { LambdaStack } from "./lambda-stack";
import { QueueStack } from "./queue-stack";

export class MainStack {
    public readonly queueStack: QueueStack;
    public readonly lambdaStack: LambdaStack;

    constructor(private prefix: string) {
        this.queueStack = new QueueStack(this.prefix);
        this.lambdaStack = new LambdaStack({
            prefix: this.prefix,
            queueStack: this.queueStack
        });
    }
}