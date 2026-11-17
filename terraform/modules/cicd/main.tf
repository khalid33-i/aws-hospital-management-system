# The account already has a GitHub OIDC provider (only one per URL is allowed), so reuse it.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  # GitHub now puts immutable numeric IDs in the "sub" claim: repo:<owner>@<owner_id>/<repo>@<repo_id>:...
  # We accept both the new format and the classic one.
  github_subjects = [
    "repo:khalid33-i@205201884/aws-hospital-management-system@1450175202:environment:${var.github_environment}",
    "repo:${var.github_repository}:environment:${var.github_environment}",
  ]
}

data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Only this repo, only jobs running in the "production" environment
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.github_subjects
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.name_prefix}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Least privilege: refresh ONE Auto Scaling Group, read refresh status. Nothing else.
data "aws_iam_policy_document" "deploy" {
  statement {
    actions   = ["autoscaling:StartInstanceRefresh", "autoscaling:CancelInstanceRefresh"]
    resources = ["arn:aws:autoscaling:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:autoScalingGroup:*:autoScalingGroupName/${var.asg_name}"]
  }

  statement {
    actions   = ["autoscaling:DescribeInstanceRefreshes", "autoscaling:DescribeAutoScalingGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "asg-instance-refresh"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}