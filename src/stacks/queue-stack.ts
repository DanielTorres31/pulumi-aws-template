import { SqsComponent } from "../components";

export class QueueStack {
    // Important: These values must be same or greater than lambda timeout
    private RETENTION_TIME_IN_SECONDS = 4 * 24 * 60 * 60; // 4 days
    private VISIBILITY_TIMEOUT_IN_SECONDS = 10 * 60; // 10 minutes

    public readonly exampleQueue: SqsComponent;

    constructor(private prefix: string) {
        this.exampleQueue = this.createExampleQueue();
    }

    private createExampleQueue() {
        return new SqsComponent({
            name: "example-queue",
            prefix: this.prefix,
            messageRetentionSeconds: this.RETENTION_TIME_IN_SECONDS,
            visibilityTimeoutSeconds: this.VISIBILITY_TIMEOUT_IN_SECONDS,
        });
    }
}