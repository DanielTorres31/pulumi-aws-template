import * as aws from "@pulumi/aws";
import * as docker from "@pulumi/docker";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";

export interface DockerImageConfig {
  readonly name: string;
  readonly prefix: string;
  readonly ecrRepository: aws.ecr.Repository;
  readonly dockerfilePath?: string;
  readonly contextPath?: string;
  readonly buildArgs?: Record<string, string>;
  readonly imageTag?: string;
}

/**
 * Reusable Docker image component that builds and pushes to ECR.
 */
export class DockerImage {
  public readonly image: docker.Image;
  public readonly imageUri: pulumi.Output<string>;
  public readonly imageName: pulumi.Output<string>;

  constructor(config: DockerImageConfig) {
    const {
      name,
      prefix,
      ecrRepository,
      dockerfilePath = "Dockerfile",
      contextPath = "../api",
      buildArgs = {},
      imageTag,
    } = config;

    const resourceName = `${prefix}-${name}`;

    // Resolve absolute paths relative to infra directory
    const infraDir = path.resolve(__dirname, "..", "..");
    const absContextPath = path.isAbsolute(contextPath)
      ? contextPath
      : path.resolve(infraDir, contextPath);
    const absDockerfilePath = path.isAbsolute(dockerfilePath)
      ? dockerfilePath
      : path.resolve(absContextPath, dockerfilePath);

    // Generate unique tag if not provided or if "latest" is used
    // This ensures Pulumi detects changes and creates new task definitions
    const finalImageTag = imageTag && imageTag !== "latest"
      ? imageTag
      : `build-${Date.now()}`;

    // Get ECR authentication
    const authToken = aws.ecr.getAuthorizationTokenOutput({
      registryId: ecrRepository.registryId,
    }).authorizationToken;

    const registryInfo = authToken.apply((token) => {
      const decoded = Buffer.from(token, "base64").toString("utf-8");
      const [username, password] = decoded.split(":");
      return {
        username: username,
        password: password,
      };
    });

    // Extract registry URL from repository URL
    const registryUrl = ecrRepository.repositoryUrl.apply((url) => {
      // Extract registry URL (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com)
      return url.split("/")[0];
    });

    // Build and push Docker image
    this.image = new docker.Image(resourceName, {
      imageName: pulumi.interpolate`${ecrRepository.repositoryUrl}:${finalImageTag}`,
      build: {
        context: absContextPath,
        dockerfile: absDockerfilePath,
        args: buildArgs,
        platform: "linux/amd64", // Required for Fargate
      },
      registry: {
        server: registryUrl,
        username: registryInfo.username,
        password: registryInfo.password,
      },
    });

    this.imageUri = this.image.imageName;
    this.imageName = this.image.imageName;
  }
}

