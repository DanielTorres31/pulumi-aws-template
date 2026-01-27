import * as aws from "@pulumi/aws";
import * as command from "@pulumi/command";
import * as pulumi from "@pulumi/pulumi";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { getDefaultTags } from "../utils/tags";

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
            tags: getDefaultTags(prefix, tags),
        });

        // Create Lambda function
        // If build is used, ensure Lambda depends on build completing
        const dependsOn = buildDependency ? [buildDependency] : undefined;

        this.function = new aws.lambda.Function(
            resourceName,
            {
                name: resourceName,
                handler: finalHandler,
                runtime: runtime,
                role: resolvedRoleArn,
                code: lambdaCode,
                timeout: timeout,
                memorySize: memorySize,
                environment: environment,
                reservedConcurrentExecutions: reservedConcurrentExecutions,
                tags: getDefaultTags(prefix, tags),
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
            name: `${resourceName}-role`,
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
            tags: getDefaultTags(prefix),
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

        // Ensure build directory exists before Pulumi tries to read it
        if (!fs.existsSync(absBuildDir)) {
            fs.mkdirSync(absBuildDir, { recursive: true });
        }

        // Metadata file that will be included in the archive
        // This file contains source file information computed at build time
        // so the archive hash changes when source files are modified
        const metadataFile = path.join(absBuildDir, ".source-metadata.json");
        
        // Write initial metadata file with current source info so Pulumi can compute initial hash
        // The build command will update this with fresh info, ensuring it's always current
        const initialMtime = fs.existsSync(absHandlerFile) 
            ? fs.statSync(absHandlerFile).mtimeMs.toString() 
            : Date.now().toString();
        const initialMetadata = {
            handlerFile: absHandlerFile,
            mtime: initialMtime,
            buildTime: new Date().toISOString(),
        };
        fs.writeFileSync(metadataFile, JSON.stringify(initialMetadata, null, 2));

        // Build command string with cd to source directory
        // Remove all files, build, then write metadata file with current source info
        // The metadata file is computed dynamically in the build command to ensure
        // it always reflects the current state of source files
        // This ensures the archive hash changes when source files change
        // Note: The command includes $(date +%s) which ensures it's unique each time it runs
        const buildCommandStr = `cd "${absSourceDir}" && DEPLOY_TIMESTAMP=$(date +%s) && mkdir -p "${absBuildDir}" && rm -rf "${absBuildDir}"/* "${absBuildDir}"/.[!.]* 2>/dev/null || true && ${esbuildCommand} && SOURCE_MTIME=$(stat -f "%m" "${absHandlerFile}" 2>/dev/null || stat -c "%Y" "${absHandlerFile}" 2>/dev/null || echo "$(date +%s)") && cat > "${metadataFile}" << EOF
{
  "handlerFile": "${absHandlerFile}",
  "mtime": "$SOURCE_MTIME",
  "buildTime": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "deployTimestamp": "$DEPLOY_TIMESTAMP"
}
EOF
echo "Build complete at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"`;

        // Compute hash of source file content to use as a trigger
        // This ensures the build runs when source files change
        let sourceFileHash: string;
        if (fs.existsSync(absHandlerFile)) {
            const fileContent = fs.readFileSync(absHandlerFile, "utf8");
            sourceFileHash = crypto.createHash("sha256").update(fileContent).digest("hex");
        } else {
            sourceFileHash = Date.now().toString();
        }

        // Get source file modification time as additional trigger
        const sourceFileMtime = fs.existsSync(absHandlerFile)
            ? fs.statSync(absHandlerFile).mtimeMs.toString()
            : Date.now().toString();

        // Include Pulumi project and stack info to ensure unique triggers per stack
        const stackName = pulumi.getStack();
        const projectName = pulumi.getProject();
        const stackIdentifier = `${projectName}-${stackName}`;

        // Compute a hash of the handler's directory to catch changes in dependencies
        // This helps ensure rebuilds when imported files change
        let directoryHash: string;
        try {
            const handlerDir = path.dirname(absHandlerFile);
            const files = fs.readdirSync(handlerDir);
            const relevantFiles = files
                .filter((f) => typeof f === "string" && (f.endsWith(".ts") || f.endsWith(".js")))
                .map((f) => {
                    const filePath = path.join(handlerDir, f as string);
                    try {
                        return fs.readFileSync(filePath, "utf8");
                    } catch {
                        return "";
                    }
                })
                .join("");
            directoryHash = crypto.createHash("sha256").update(relevantFiles).digest("hex");
        } catch {
            directoryHash = Date.now().toString();
        }

        // Include esbuild binary modification time to catch dependency updates
        // This ensures rebuilds when build tools are updated
        let esbuildMtime: string;
        try {
            if (fs.existsSync(esbuildPath)) {
                esbuildMtime = fs.statSync(esbuildPath).mtimeMs.toString();
            } else {
                esbuildMtime = Date.now().toString();
            }
        } catch {
            esbuildMtime = Date.now().toString();
        }

        // Get current time as a trigger value
        // Note: This is computed once per Pulumi program execution, so it will be the same
        // within a single deployment but different across deployments when the program re-runs
        const deploymentTime = Date.now().toString();

        // Execute build commands using @pulumi/command
        // Multiple triggers ensure the build runs when source files change
        // The command itself includes a timestamp in the output, ensuring the archive hash changes
        // To force rebuilds on every deployment, ensure the Pulumi program re-runs (which it does)
        // and the triggers will be re-evaluated, potentially causing the command to run
        const buildStep = new command.local.Command(
            `${name}-build`,
            {
                create: buildCommandStr,
                update: buildCommandStr,
                delete: `rm -rf "${absBuildDir}"`,
                triggers: [
                    // Trigger on source file content changes (most reliable)
                    sourceFileHash,
                    // Trigger on source file modification time changes
                    sourceFileMtime,
                    // Trigger on directory-level changes (catches dependency changes)
                    directoryHash,
                    // Trigger on esbuild binary changes (catches tool updates)
                    esbuildMtime,
                    // Include stack identifier for consistency
                    stackIdentifier,
                    // Include deployment time (computed at Pulumi runtime)
                    // This ensures triggers are re-evaluated on each Pulumi run
                    deploymentTime,
                ],
            },
            {
                // Use retainOnDelete to keep build artifacts for debugging
                retainOnDelete: false,
            }
        );

        // Use FileArchive with the build directory
        // The metadata file (written by build command) ensures the archive hash 
        // changes when source files change, triggering Lambda updates
        // The dependsOn ensures the build runs before the archive is read
        const archive = new pulumi.asset.FileArchive(absBuildDir);

        return {
            code: archive,
            buildCommand: buildStep,
        };
    }
}

