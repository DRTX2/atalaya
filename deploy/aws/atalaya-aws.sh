#!/usr/bin/env bash
# Atalaya on AWS, demo-sized, with a budget alarm first and a one-command teardown.
#
#   deploy/aws/atalaya-aws.sh plan     # default: show what would be created, spend nothing
#   deploy/aws/atalaya-aws.sh up       # create everything (asks you to type the account ID)
#   deploy/aws/atalaya-aws.sh down     # destroy everything, then list anything tagged that is left
#   deploy/aws/atalaya-aws.sh status   # public URLs and what is still running
#
# Required (never committed): ATALAYA_AWS_ACCOUNT (the account you expect your credentials to be for),
# ATALAYA_BUDGET_USD (monthly alarm, 1-200), ATALAYA_ALERT_EMAIL (budget alerts). Optional: AWS_REGION.
# Estimated cost while up: ~0.30 USD/hour (see README.md). Run `down` when the demo is over.
set -euo pipefail

cmd=${1:-plan}
here=$(cd "$(dirname "$0")" && pwd)
apps=$(cd "$here/../../.." && pwd) # the product repos sit next to atalaya/
region=${AWS_REGION:-us-east-1}
state_dir="$here/.state" # local-only: generated secrets and bootstrap state (gitignored)
die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[[ $cmd =~ ^(plan|up|down|status)$ ]] || die "unknown command '$cmd' (plan | up | down | status)"
for tool in aws terraform docker node; do command -v "$tool" >/dev/null || die "$tool is required"; done
: "${ATALAYA_AWS_ACCOUNT:?set ATALAYA_AWS_ACCOUNT to the AWS account ID you intend to deploy to}"

# Guard 1: the credentials in use belong to the account you named (no deploying to the wrong one).
account=$(aws sts get-caller-identity --query Account --output text) || die "no working AWS credentials"
[[ $account == "$ATALAYA_AWS_ACCOUNT" ]] || die "credentials are for account $account, not $ATALAYA_AWS_ACCOUNT"
bucket="atalaya-tfstate-$account-$region"
mkdir -p "$state_dir" && chmod 700 "$state_dir"

# terraform <stack dir> <state key> <init|plan|apply|destroy|output> [args...]
tf() {
  local dir=$1 key=$2 action=$3; shift 3
  terraform -chdir="$dir" init -input=false -reconfigure \
    -backend-config="bucket=$bucket" -backend-config="key=atalaya-demo/$key.tfstate" \
    -backend-config="region=$region" -backend-config="use_lockfile=true" -backend-config="encrypt=true" >/dev/null
  [[ $action == init ]] && return
  terraform -chdir="$dir" "$action" -input=false "$@"
}

secret() { # random secret, generated once and kept locally so re-runs are idempotent
  local f="$state_dir/$1"
  [[ -s $f ]] || { umask 077; openssl rand -hex 32 >"$f"; }
  cat "$f"
}

ensure_state_bucket() {
  aws s3api head-bucket --bucket "$bucket" 2>/dev/null && return
  step "Terraform state bucket $bucket"
  if [[ $region == us-east-1 ]]; then aws s3api create-bucket --bucket "$bucket" >/dev/null
  else aws s3api create-bucket --bucket "$bucket" --create-bucket-configuration "LocationConstraint=$region" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
}

push_images() { # <repo dir> <terraform output with the ECR URL map> <tag> <name=dockerfile>...
  local repo=$1 output=$2 tag=$3; shift 3
  aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$account.dkr.ecr.$region.amazonaws.com" >/dev/null
  for pair in "$@"; do
    local name=${pair%%=*} dockerfile=${pair#*=} url
    url=$(terraform -chdir="$apps/$repo/infra/terraform" output -json "$output" | node -e "const o=JSON.parse(require('fs').readFileSync(0)); process.stdout.write(typeof o==='string'?o:o['$name'])")
    docker build --platform linux/amd64 -f "$apps/$repo/$dockerfile" -t "$url:$tag" "$apps/$repo"
    docker push "$url:$tag"
  done
}

integration_secret() { # one Secrets Manager secret the products read the shared integration values from
  local name=atalaya-demo/integration value
  value=$(node -e 'console.log(JSON.stringify({ NIMBUS_WEBHOOK_SECRET: process.argv[1], HOOKRELAY_API_KEY: process.argv[2] || "pending" }))' "$(secret nimbus-webhook-secret)" "${1:-}")
  if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$name" --secret-string "$value" >/dev/null
  else
    aws secretsmanager create-secret --name "$name" --secret-string "$value" --tags Key=Project,Value=atalaya >/dev/null
  fi
  aws secretsmanager describe-secret --secret-id "$name" --query ARN --output text
}

hookrelay_vars() { echo -var-file="$here/demo.hookrelay.tfvars" -var="image_tag=$(git -C "$apps/hookrelay" rev-parse --short HEAD)" -var="integration_secret_arn=$1"; }
flagship_vars() { echo -var-file="$here/demo.flagship.tfvars" -var="image_tag=$(git -C "$apps/flagship" rev-parse --short HEAD)" -var="integration_secret_arn=$1" -var="hookrelay_url=$2"; }
budget_vars() {
  : "${ATALAYA_BUDGET_USD:?set ATALAYA_BUDGET_USD (monthly alarm in USD, 1-200)}" "${ATALAYA_ALERT_EMAIL:?set ATALAYA_ALERT_EMAIL for budget alerts}"
  echo -var="region=$region" -var="monthly_limit_usd=$ATALAYA_BUDGET_USD" -var="alert_email=$ATALAYA_ALERT_EMAIL"
}

case $cmd in
plan)
  ensure_state_bucket # the only thing plan creates: an empty, private, versioned bucket (cents per month)
  step "Plan: budget";    tf "$here/budget" budget plan $(budget_vars)
  step "Plan: Bitácora";  (cd "$apps/bitacora" && npm run build --silent); tf "$apps/bitacora/infra/terraform" bitacora plan -var="region=$region" -var="api_token=$(secret bitacora-token)"
  step "Plan: Hookrelay"; tf "$apps/hookrelay/infra/terraform" hookrelay plan $(hookrelay_vars "")
  step "Plan: Flagship";  tf "$apps/flagship/infra/terraform" flagship plan $(flagship_vars "" "")
  echo; echo "Nothing was created besides the state bucket. To deploy: $0 up"
  ;;

up)
  # Guard 2: a person types the account ID before anything that costs money.
  read -r -p "This creates billable resources (~0.30 USD/hour) in account $account ($region). Type the account ID to continue: " typed
  [[ $typed == "$account" ]] || die "not confirmed"
  ensure_state_bucket
  step "1/6 Budget alarm (before anything that costs money)"
  tf "$here/budget" budget apply -auto-approve $(budget_vars)

  step "2/6 Bitácora (Lambda + DynamoDB + API Gateway)"
  (cd "$apps/bitacora" && npm ci --silent && npm run build --silent)
  tf "$apps/bitacora/infra/terraform" bitacora apply -auto-approve -var="region=$region" -var="api_token=$(secret bitacora-token)"
  bitacora_url=$(terraform -chdir="$apps/bitacora/infra/terraform" output -raw api_url)

  step "3/6 Hookrelay (ECS Fargate + RDS + ElastiCache)"
  secret_arn=$(integration_secret)
  tf "$apps/hookrelay/infra/terraform" hookrelay apply -auto-approve -target=aws_ecr_repository.app $(hookrelay_vars "$secret_arn")
  push_images hookrelay ecr_repositories "$(git -C "$apps/hookrelay" rev-parse --short HEAD)" api=apps/api/Dockerfile web=apps/web/Dockerfile
  tf "$apps/hookrelay/infra/terraform" hookrelay apply -auto-approve $(hookrelay_vars "$secret_arn")
  hookrelay_url=$(terraform -chdir="$apps/hookrelay/infra/terraform" output -raw url)

  step "4/6 Wire Hookrelay ↔ Bitácora (bootstrap.mjs against the public URLs)"
  hookrelay_admin=$(aws secretsmanager get-secret-value --secret-id hookrelay-demo/app --query SecretString --output text | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0)).ADMIN_TOKEN)")
  until curl -fs "$hookrelay_url/health" >/dev/null; do sleep 10; done
  STATE_DIR="$state_dir" HOOKRELAY_URL="$hookrelay_url" BITACORA_URL="$bitacora_url" ADMIN_TOKEN="$hookrelay_admin" BITACORA_TOKEN="$(secret bitacora-token)" node "$here/../../bootstrap.mjs"
  secret_arn=$(integration_secret "$(cat "$state_dir/hookrelay-api-key")")

  step "5/6 Flagship (ECS Fargate + RDS), publishing to Hookrelay"
  tf "$apps/flagship/infra/terraform" flagship apply -auto-approve -target=aws_ecr_repository.app $(flagship_vars "$secret_arn" "$hookrelay_url")
  push_images flagship ecr_repository "$(git -C "$apps/flagship" rev-parse --short HEAD)" app=Dockerfile
  tf "$apps/flagship/infra/terraform" flagship apply -auto-approve $(flagship_vars "$secret_arn" "$hookrelay_url")

  step "6/6 Done"
  "$0" status
  echo; echo "Nimbus is not deployed by this script (see README.md: it needs a public image and an SSM env file)."
  echo "Remember: $0 down"
  ;;

down)
  read -r -p "Destroy every Atalaya demo resource in account $account ($region)? Type the account ID: " typed
  [[ $typed == "$account" ]] || die "not confirmed"
  # Reverse order; each destroy is safe to re-run. The budget goes last so it watches the teardown.
  [[ -f $state_dir/hookrelay-api-key ]] || echo "pending" >"$state_dir/hookrelay-api-key"
  arn=$(aws secretsmanager describe-secret --secret-id atalaya-demo/integration --query ARN --output text 2>/dev/null || echo "")
  step "Flagship";  tf "$apps/flagship/infra/terraform" flagship destroy -auto-approve $(flagship_vars "$arn" "http://unused")
  step "Hookrelay"; tf "$apps/hookrelay/infra/terraform" hookrelay destroy -auto-approve $(hookrelay_vars "$arn")
  step "Bitácora";  tf "$apps/bitacora/infra/terraform" bitacora destroy -auto-approve -var="region=$region" -var="api_token=$(secret bitacora-token)"
  # Terraform schedules secret deletion (7-day recovery); force it, or the next `up` cannot reuse the names.
  for s in atalaya-demo/integration hookrelay-demo/app hookrelay-demo/web-api-key flagship-demo/app; do
    aws secretsmanager delete-secret --secret-id "$s" --force-delete-without-recovery >/dev/null 2>&1 || true
  done
  step "Budget";    tf "$here/budget" budget destroy -auto-approve -var="region=$region" -var="monthly_limit_usd=1" -var="alert_email=unused@example.com"
  step "Anything still tagged Project=atalaya|flagship|hookrelay"
  left=$(aws resourcegroupstaggingapi get-resources --region "$region" --tag-filters Key=Project,Values=atalaya,flagship,hookrelay --query 'ResourceTagMappingList[].ResourceARN' --output text)
  if [[ -n $left ]]; then echo "$left" | tr '\t' '\n'; die "resources left behind (some, like ECR or log groups, may take a minute)"; fi
  echo "Nothing left. The state bucket $bucket remains (empty stacks, cents per month): aws s3 rb s3://$bucket --force"
  ;;

status)
  for s in bitacora:api_url hookrelay:url flagship:url; do
    repo=${s%%:*} out=${s#*:}
    tf "$apps/$repo/infra/terraform" "$repo" init
    printf '%-10s %s\n' "$repo" "$(terraform -chdir="$apps/$repo/infra/terraform" output -raw "$out" 2>/dev/null || echo 'not deployed')"
  done
  aws ecs list-clusters --region "$region" --query 'clusterArns' --output text | tr '\t' '\n' | grep -E 'flagship|hookrelay' || echo "no ECS clusters running"
  ;;
esac
