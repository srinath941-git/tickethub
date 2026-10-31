variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "project" {
  type    = string
  default = "tickethub"
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "key_name" {
  type        = string
  description = "Name of an existing EC2 key pair in the chosen region"
}

variable "private_key_path" {
  type        = string
  description = "Path to the .pem file of that key pair on your workstation"
}

variable "my_ip_cidr" {
  type        = string
  description = "Your public IP in CIDR form, for example 203.0.113.10/32"
}
