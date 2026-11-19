# Atalaya on AWS (demo deployment)

One command up, one command down, with a budget alarm in place before anything that costs money.
It reuses each product's own Terraform (`../<product>/infra/terraform`) with demo sizing.

> **Status:** prepared and validated (`terraform validate`, guard paths tested), **never applied**.
> The first real `up` is where the remaining surprises will show; expect to fix one or two things.

## What gets created

| Product | AWS | Public URL |
|---|---|---|
| Bitácora | Lambda + API Gateway (HTTP) + DynamoDB (on demand) + KMS | API Gateway URL |
| Hookrelay | ECS Fargate (API, worker, dashboard) + RDS PostgreSQL + ElastiCache Redis + ALB + VPC | ALB DNS name (HTTP) |
| Flagship | ECS Fargate + RDS PostgreSQL + ALB + VPC, publishing flag events to Hookrelay | ALB DNS name (HTTP) |
| Budget | AWS Budgets alarm: 25/50/80/100 % of actual spend and 100 % of forecast | — |

Integration on AWS uses one Secrets Manager secret (`atalaya-demo/integration`) with the shared Nimbus
webhook secret and Hookrelay's platform API key; `bootstrap.mjs` runs from your machine against the
public URLs to create the tenant and Bitácora's subscription, exactly as it does in Docker.

## Cost (estimate, us-east-1)

Rough list prices; check them in the AWS Pricing Calculator before the first deploy.

| Item | Count | ≈ USD/hour |
|---|---|---|
| NAT gateway (one per VPC) | 2 | 0.090 |
| Application Load Balancer | 2 | 0.050 |
| RDS db.t4g.micro, single AZ | 2 | 0.032 |
| ElastiCache cache.t4g.micro | 1 | 0.016 |
| Fargate tasks (Flagship 1, Hookrelay API + worker + web) | 4 | 0.050 |
| Public IPv4 addresses (NAT, ALBs) | ~6 | 0.030 |
| Lambda, API Gateway, DynamoDB, Secrets Manager, KMS | — | ≈ 0 at demo traffic |
| **Total** | | **≈ 0.27–0.30** |

A 3-hour demo costs about **1 USD**. Left running it is **≈ 7 USD/day, ≈ 200 USD/month**, which is why
`down` exists and the budget alarm is created first. A budget only alerts; it never stops spending.

## Use

```bash
export ATALAYA_AWS_ACCOUNT=123456789012      # the account you mean; credentials for any other are refused
export ATALAYA_BUDGET_USD=25                 # monthly alarm (1–200)
export ATALAYA_ALERT_EMAIL=you@example.com   # budget alerts; never committed
export AWS_REGION=us-east-1

deploy/aws/atalaya-aws.sh plan     # spends nothing (creates only the private, versioned state bucket)
deploy/aws/atalaya-aws.sh up       # asks you to type the account ID, then ~20 min
deploy/aws/atalaya-aws.sh status   # public URLs
deploy/aws/atalaya-aws.sh down     # asks again; destroys everything and lists anything left behind
```

Prerequisites: AWS CLI v2 with credentials, Terraform ≥ 1.6, Docker (images are built for linux/amd64
and pushed to each product's ECR), Node 24. Generated secrets live in `deploy/aws/.state/` (gitignored).

## Safety rails

- **Wrong account:** the credentials' account must equal `ATALAYA_AWS_ACCOUNT`, and `up`/`down` make you type it.
- **Plan by default:** the script does nothing billable unless you run `up`.
- **Budget first, last out:** created before any stack, destroyed after all of them.
- **Teardown check:** after `down`, the tagging API is queried for anything still tagged
  `Project=atalaya|flagship|hookrelay`; the script fails if something is left.
- **Secrets:** Terraform schedules Secrets Manager deletions for 7 days; `down` force-deletes them so the
  next `up` can reuse the names.

## Not covered yet (honest gaps)

- **Nimbus** is not deployed by the script. Its sandbox Terraform (`../nimbus/infra/terraform/environments/sandbox`)
  is a private EC2 instance reached through SSM port forwarding; it needs a published container image
  and an SSM env file. Without Nimbus there is no automatic detection on AWS; Flagship, Hookrelay and
  Bitácora still work and integrate.
- **The orders app** (real SQS + Lambda consumer) and **the console + Keycloak** are local only.
- **HTTPS:** load balancers serve HTTP on their DNS names unless you pass an ACM `certificate_arn`.
- **Tracing** on AWS would use the ADOT Lambda layer and a collector sidecar; not wired.
