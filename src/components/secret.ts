import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { getDefaultTags } from "../utils/tags";

export interface SecretComponentConfig {
  readonly name: string;
  readonly prefix: string;
  readonly description?: string;
  readonly secretString?: pulumi.Input<string>;
  readonly secretBinary?: pulumi.Input<string>;
  readonly kmsKeyId?: pulumi.Input<string>;
  readonly recoveryWindowInDays?: number;
  readonly rotationEnabled?: boolean;
  readonly rotationLambdaArn?: pulumi.Input<string>;
  readonly rotationRules?: aws.types.input.secretsmanager.SecretRotationRotationRules;
  readonly tags?: Record<string, string>;
}

/**
 * Reusable AWS Secrets Manager secret component with common configurations.
 */
export class SecretComponent {
  public readonly secret: aws.secretsmanager.Secret;
  public readonly secretArn: pulumi.Output<string>;
  public readonly secretName: pulumi.Output<string>;
  public readonly secretValue: pulumi.Output<string>;

  constructor(config: SecretComponentConfig) {
    const {
      name,
      prefix,
      description,
      secretString,
      secretBinary,
      kmsKeyId,
      recoveryWindowInDays,
      rotationEnabled = false,
      rotationLambdaArn,
      rotationRules,
      tags = {},
    } = config;

    const resourceName = `${prefix}-${name}`;

    if (!secretString && !secretBinary) {
      throw new Error(
        "Either secretString or secretBinary must be provided"
      );
    }

    if (secretString && secretBinary) {
      throw new Error(
        "Cannot provide both secretString and secretBinary"
      );
    }

    // Create the secret
    this.secret = new aws.secretsmanager.Secret(resourceName, {
      name: resourceName,
      description: description,
      kmsKeyId: kmsKeyId,
      recoveryWindowInDays: recoveryWindowInDays,
      tags: getDefaultTags(prefix, tags),
    });

    this.secretArn = this.secret.arn;
    this.secretName = this.secret.name;

    // Store the secret value as an Output for direct access
    // Convert Input<string> to Output<string>
    // This allows passing the secret value directly to Lambda environment variables
    if (secretString) {
      this.secretValue = pulumi.output(secretString);
      new aws.secretsmanager.SecretVersion(`${resourceName}-version`, {
        secretId: this.secret.id,
        secretString: secretString,
      });
    } else if (secretBinary) {
      this.secretValue = pulumi.output(secretBinary);
      new aws.secretsmanager.SecretVersion(`${resourceName}-version`, {
        secretId: this.secret.id,
        secretBinary: secretBinary,
      });
    } else {
      // This should never happen due to validation above, but TypeScript needs it
      this.secretValue = pulumi.output("");
    }

    // Configure rotation if enabled
    if (rotationEnabled) {
      if (!rotationLambdaArn) {
        throw new Error(
          "rotationLambdaArn is required when rotationEnabled is true"
        );
      }

      if (!rotationRules) {
        throw new Error(
          "rotationRules is required when rotationEnabled is true"
        );
      }

      new aws.secretsmanager.SecretRotation(`${resourceName}-rotation`, {
        secretId: this.secret.id,
        rotationLambdaArn: rotationLambdaArn,
        rotationRules,
      });
    }
  }
}
