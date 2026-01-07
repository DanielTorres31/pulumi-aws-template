#!/bin/bash

# Bootstrap script to create S3 bucket for Pulumi state storage
# This should be run once before using Pulumi with S3 backend

set -e

PROJECT_NAME="project-name"
ENVIRONMENT="dev"
REGION="us-east-1"
BUCKET_NAME="${PROJECT_NAME}-pulumi-state"

echo "Creating S3 bucket for Pulumi state: ${BUCKET_NAME}"

# Check if bucket already exists
if aws s3api head-bucket --bucket "${BUCKET_NAME}" 2>/dev/null; then
  echo "Bucket ${BUCKET_NAME} already exists. Skipping creation."
else
  # Create bucket
  if [ "${REGION}" = "us-east-1" ]; then
    # us-east-1 doesn't require LocationConstraint
    aws s3api create-bucket \
      --bucket "${BUCKET_NAME}" \
      --region "${REGION}"
  else
    aws s3api create-bucket \
      --bucket "${BUCKET_NAME}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}"
  fi

  echo "Bucket ${BUCKET_NAME} created successfully."
fi

# Enable versioning
echo "Enabling versioning on ${BUCKET_NAME}..."
aws s3api put-bucket-versioning \
  --bucket "${BUCKET_NAME}" \
  --versioning-configuration Status=Enabled

# Enable encryption
echo "Enabling encryption on ${BUCKET_NAME}..."
aws s3api put-bucket-encryption \
  --bucket "${BUCKET_NAME}" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Block public access
echo "Blocking public access on ${BUCKET_NAME}..."
aws s3api put-public-access-block \
  --bucket "${BUCKET_NAME}" \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

echo ""
echo "✅ S3 bucket ${BUCKET_NAME} is ready for Pulumi state storage!"
echo ""
echo "Next steps:"
echo "1. Configure Pulumi to use this bucket:"
echo "   cd infra"
echo "   pulumi login s3://${BUCKET_NAME}"
echo ""
echo "2. Initialize your stack:"
echo "   pulumi stack init dev"
echo ""
echo "3. Install dependencies and deploy:"
echo "   npm install"
echo "   pulumi up"
