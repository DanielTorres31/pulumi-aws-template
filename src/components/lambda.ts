import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import * as fs from "fs";

export interface LambdaBuildConfig {
    readonly handlerFile: string;
    readonly handlerExport?: string;
    readonly sourceDir: string;
    readonly buildDir?: string;
    readonly tsconfigPath?: string;
    readonly externalPackages?: string[];
    readonly nodeVersion?: string;
}

/**
 * Note: When using build config, the handler should be in the format:
 * "handler.{exportName}" where exportName matches handlerExport (default: "lambdaHandler").
 * Example: handler="handler.lambdaHandler" with handlerExport="lambdaHandler"
 */

export interface LambdaComponentConfig {
    readonly name: string;
    readonly prefix: string;
    readonly handler: string;
    readonly runtime?: string;
    readonly role?: aws.iam.Role;
    readonly roleArn?: pulumi.Input<string>;
    readonly code?: pulumi.asset.AssetArchive;
    readonly build?: LambdaBuildConfig;
    readonly timeout?: number;
    readonly memorySize?: number;
    readonly environment?: {
        readonly variables?: Record<string, pulumi.Input<string>>;
    };
    readonly reservedConcurrentExecutions?: number;
    readonly tags?: Record<string, string>;
    readonly logRetentionInDays?: number;
}

/**
 * Reusable Lambda function component with common configurations.
 */
export class LambdaComponent {
    public readonly function: aws.lambda.Function;
    public readonly functionName: pulumi.Output<string>;
    public readonly functionArn: pulumi.Output<string>;
    public readonly invokeArn: pulumi.Output<string>;
    public readonly logGroup?: aws.cloudwatch.LogGroup;
    public buildCommand?: command.local.Command;

    constructor(config: LambdaComponentConfig) {
        const {
            name,
            prefix,
            handler,
            runtime = "nodejs24.x",
            role,
            roleArn,
            code,
            build,
            timeout = 3,
            memorySize = 128,
            environment,
            reservedConcurrentExecutions,
            tags = {},
            logRetentionInDays = 7,
        } = config;

        if (!role && !roleArn) {
            throw new Error("Either 'role' or 'roleArn' must be provided for Lambda function");
        }

        if (!code && !build) {
            throw new Error("Either 'code' or 'build' must be provided for Lambda function");
        }

        const resourceName = `${prefix}-${name}`;

        const resolvedRoleArn = roleArn || role!.arn;

        // Build Lambda code if build config is provided
        // When using build, the handler format should be "handler.{exportName}"
        const finalHandler = build
            ? `handler.${build.handlerExport || "lambdaHandler"}`
            : handler;

        // If building, create build command first, then create code asset that depends on it
        let lambdaCode: pulumi.asset.Archive;
        let buildDependency: command.local.Command | undefined;

        if (build) {
            const buildResult = this.buildLambdaCode(resourceName, build, finalHandler);
            lambdaCode = buildResult.code;
            buildDependency = buildResult.buildCommand;
            this.buildCommand = buildDependency;
        } else {
            lambdaCode = code!;
        }

        // Create CloudWatch log group for Lambda
        this.logGroup = new aws.cloudwatch.LogGroup(`${resourceName}-logs`, {
            name: `/aws/lambda/${resourceName}`,
            retentionInDays: logRetentionInDays,
            tags: {
                ...tags,
                ManagedBy: "Pulumi",
            },
        });

        // Create Lambda function
        // If build is used, ensure Lambda depends on build completing
        const dependsOn = buildDependency ? [buildDependency] : undefined;

        this.function = new aws.lambda.Function(
            resourceName,
            {
                name: resourceName,
                handler: handler,
                runtime: runtime,
                role: resolvedRoleArn,
                code: lambdaCode,
                timeout: timeout,
                memorySize: memorySize,
                environment: environment,
                reservedConcurrentExecutions: reservedConcurrentExecutions,
                tags: {
                    ...tags,
                    ManagedBy: "Pulumi",
                },
            },
            {
                dependsOn: dependsOn,
            }
        );

        // Grant CloudWatch Logs permissions
        new aws.lambda.Permission(`${resourceName}-logs-permission`, {
            action: "lambda:InvokeFunction",
            function: this.function.name,
            principal: "logs.amazonaws.com",
        });

        this.functionName = this.function.name;
        this.functionArn = this.function.arn;
        this.invokeArn = pulumi.interpolate`${this.functionArn}:${this.function.version}`;
    }

    /**
     * Create a basic execution role for the Lambda function.
     */
    static createExecutionRole(
        { name, additionalPolicies, prefix }: {
            name: string,
            additionalPolicies?: pulumi.Input<aws.iam.PolicyDocument>,
            prefix: string
        }
    ): aws.iam.Role {
        const resourceName = `${prefix}-${name}`;

        const role = new aws.iam.Role(`${resourceName}-role`, {
            name: resourceName ? `${resourceName}-role` : undefined,
            assumeRolePolicy: pulumi.jsonStringify({
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Principal: {
                            Service: "lambda.amazonaws.com",
                        },
                        Action: "sts:AssumeRole",
                    },
                ],
            }),
        });

        // Attach basic Lambda execution policy
        new aws.iam.RolePolicyAttachment(`${resourceName}-basic-execution`, {
            role: role.name,
            policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
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
     * Build Lambda code using esbuild and create an Archive.
     */
    private buildLambdaCode(
        name: string,
        buildConfig: LambdaBuildConfig,
        handlerName: string
    ): { code: pulumi.asset.Archive; buildCommand: command.local.Command } {
        const {
            handlerFile,
            handlerExport = "lambdaHandler",
            sourceDir,
            buildDir = `.lambda-build-${name}`,
            tsconfigPath,
            externalPackages = ["@aws-sdk/*"],
            nodeVersion = "node24",
        } = buildConfig;

        // Resolve absolute paths
        const absSourceDir = path.isAbsolute(sourceDir) ? sourceDir : path.resolve(sourceDir);
        const absHandlerFile = path.isAbsolute(handlerFile)
            ? handlerFile
            : path.resolve(absSourceDir, handlerFile);
        const absBuildDir = path.isAbsolute(buildDir) ? buildDir : path.resolve(absSourceDir, buildDir);
        const absTsconfigPath = tsconfigPath
            ? path.isAbsolute(tsconfigPath)
                ? tsconfigPath
                : path.resolve(absSourceDir, tsconfigPath)
            : path.resolve(absSourceDir, "tsconfig.json");

        // Verify handler file exists
        if (!fs.existsSync(absHandlerFile)) {
            throw new Error(`Handler file not found: ${absHandlerFile}`);
        }

        // Check if esbuild is available
        const esbuildPath = path.resolve(absSourceDir, "node_modules/.bin/esbuild");
        if (!fs.existsSync(esbuildPath)) {
            throw new Error(
                `esbuild not found at ${esbuildPath}. Install it with: npm install --save-dev esbuild`
            );
        }

        const bundleFile = path.join(absBuildDir, "handler.cjs");
        const zipFile = path.join(absBuildDir, "lambda.zip");

        // Build esbuild command
        const tsconfigFlag = fs.existsSync(absTsconfigPath) ? `--tsconfig=${absTsconfigPath}` : "";
        const externalFlags = externalPackages.map((pkg) => `--external:${pkg}`).join(" ");

        const esbuildCommand = [
            `"${esbuildPath}"`,
            `"${absHandlerFile}"`,
            "--bundle",
            "--platform=node",
            `--target=${nodeVersion}`,
            "--format=cjs",
            `--outfile="${bundleFile}"`,
            "--sources-content=false",
            "--log-level=info",
            externalFlags,
            tsconfigFlag,
        ]
            .filter(Boolean)
            .join(" ");

        // Ensure build directory exists and has a placeholder file before Pulumi tries to read it
        // This prevents the "no such file or directory" error during planning
        // The placeholder will be replaced by the actual build during deployment
        if (!fs.existsSync(absBuildDir)) {
            fs.mkdirSync(absBuildDir, { recursive: true });
        }
        // Create a placeholder file so the directory isn't empty when Pulumi computes the hash
        const placeholderFile = path.join(absBuildDir, ".pulumi-placeholder");
        if (!fs.existsSync(placeholderFile)) {
            fs.writeFileSync(placeholderFile, "// Placeholder - will be replaced during build\n");
        }

        // Build command string with cd to source directory
        // Note: We only build the bundle file, Pulumi's FileArchive will zip the directory
        const buildCommandStr = `cd "${absSourceDir}" && mkdir -p "${absBuildDir}" && rm -f "${absBuildDir}"/* && ${esbuildCommand} && echo "Build complete"`;

        // Execute build commands using @pulumi/command
        const buildStep = new command.local.Command(
            `${name}-build`,
            {
                create: buildCommandStr,
                update: buildCommandStr,
                delete: `rm -rf "${absBuildDir}"`,
            }
        );

        // Use the build directory as an archive (Pulumi will zip it automatically)
        // This way Pulumi can compute the hash from the directory structure
        // and the build command ensures the files exist before Lambda tries to use them
        // Note: We build to handler.cjs, and Pulumi will zip the directory containing it
        return {
            code: new pulumi.asset.FileArchive(absBuildDir),
            buildCommand: buildStep,
        };
    }
}

