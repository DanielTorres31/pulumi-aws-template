import * as pulumi from "@pulumi/pulumi";
import { MainStack } from "./stacks/main-stack";

const config = new pulumi.Config();
const prefix = config.require("prefix");

if (!prefix || prefix.trim() === "") {
  throw new Error(
    "Prefix is required but not configured. Please set 'prefix' in your Pulumi stack config (e.g., Pulumi.dev.yaml)."
  );
}

const mainStack = new MainStack(prefix);