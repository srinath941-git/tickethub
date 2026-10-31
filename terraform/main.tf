terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# ---------- Image and naming ----------
data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
}

locals {
  nodes = {
    jenkins = "ci"
    master  = "control_plane"
    worker1 = "worker"
    worker2 = "worker"
  }

  public_rules = {
    ssh     = { port = 22, cidr = var.my_ip_cidr }
    jenkins = { port = 8080, cidr = var.my_ip_cidr }
    api     = { port = 6443, cidr = var.my_ip_cidr }
    http    = { port = 80, cidr = "0.0.0.0/0" }
    https   = { port = 443, cidr = "0.0.0.0/0" }
  }
}

# ---------- Network ----------
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  availability_zone       = "${var.region}a"
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.project}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }

  tags = { Name = "${var.project}-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# ---------- Security group (one group for all four servers) ----------
resource "aws_security_group" "nodes" {
  name   = "${var.project}-nodes"
  vpc_id = aws_vpc.main.id

  # Pod and node traffic inside the group must never be blocked
  ingress {
    description = "All traffic between the servers"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  dynamic "ingress" {
    for_each = local.public_rules
    content {
      description = ingress.key
      from_port   = ingress.value.port
      to_port     = ingress.value.port
      protocol    = "tcp"
      cidr_blocks = [ingress.value.cidr]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-nodes" }
}

# ---------- Servers ----------
resource "aws_instance" "node" {
  for_each               = local.nodes
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.nodes.id]
  key_name               = var.key_name

  root_block_device {
    volume_size = 25
    volume_type = "gp3"
  }

  tags = {
    Name = "${var.project}-${each.key}"
    Role = each.value
  }
}

# Fixed public addresses for Jenkins and for the ingress node (worker1)
resource "aws_eip" "jenkins" {
  domain   = "vpc"
  instance = aws_instance.node["jenkins"].id
}

resource "aws_eip" "ingress" {
  domain   = "vpc"
  instance = aws_instance.node["worker1"].id
}

# ---------- Ansible inventory, generated from the real IP addresses ----------
resource "local_file" "inventory" {
  filename = "${path.module}/../ansible/inventory.ini"
  content = templatefile("${path.module}/inventory.tpl", {
    key_file       = var.private_key_path
    jenkins_public = aws_eip.jenkins.public_ip
    master_public  = aws_instance.node["master"].public_ip
    worker1_public = aws_eip.ingress.public_ip
    worker2_public = aws_instance.node["worker2"].public_ip
    ips            = { for k, v in aws_instance.node : k => v.private_ip }
  })
}
