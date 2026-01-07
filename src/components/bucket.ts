import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export interface BucketComponentConfig {
  readonly name: string;
  readonly prefix: string;
  readonly versioning?: boolean;
  readonly encryption?: "AES256" | "aws:kms";
  readonly kmsKeyId?: pulumi.Input<string>;
  readonly publicAccessBlock?: boolean;
  readonly lifecycleRules?: aws.types.input.s3.BucketLifecycleConfigurationV2Rule[];
  readonly corsRules?: aws.types.input.s3.BucketCorsRule[];
  readonly tags?: Record<string, string>;
}

/**
 * Reusable S3 bucket component with common configurations.
 */
export class BucketComponent {
  public readonly bucket: aws.s3.Bucket;
  public readonly bucketName: pulumi.Output<string>;
  public readonly bucketArn: pulumi.Output<string>;

  constructor(config: BucketComponentConfig) {
    const {
      name,
      prefix,
      versioning = false,
      encryption = "AES256",
      kmsKeyId,
      publicAccessBlock = true,
      lifecycleRules = [],
      corsRules = [],
      tags = {},
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Create the bucket
    this.bucket = new aws.s3.Bucket(resourceName, {
      tags: {
        ...tags,
        ManagedBy: "Pulumi",
      },
    });

    this.bucketName = this.bucket.id;
    this.bucketArn = this.bucket.arn;

    // Configure versioning if enabled
    if (versioning) {
      new aws.s3.BucketVersioning(`${resourceName}-versioning`, {
        bucket: this.bucket.id,
        versioningConfiguration: {
          status: "Enabled",
        },
      });
    }

    // Configure encryption
    new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${resourceName}-encryption`,
      {
        bucket: this.bucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: {
              sseAlgorithm: encryption,
              ...(encryption === "aws:kms" && kmsKeyId ? { kmsMasterKeyId: kmsKeyId } : {}),
            },
          },
        ],
      }
    );

    // Block public access if enabled
    if (publicAccessBlock) {
      new aws.s3.BucketPublicAccessBlock(`${resourceName}-pab`, {
        bucket: this.bucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }

    // Configure lifecycle rules if provided
    if (lifecycleRules.length > 0) {
      new aws.s3.BucketLifecycleConfigurationV2(`${resourceName}-lifecycle`, {
        bucket: this.bucket.id,
        rules: lifecycleRules,
      });
    }

    // Configure CORS if provided
    if (corsRules.length > 0) {
      new aws.s3.BucketCorsConfigurationV2(`${resourceName}-cors`, {
        bucket: this.bucket.id,
        corsRules: corsRules,
      });
    }
  }
}

