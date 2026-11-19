# Demo sizing: one of everything, single AZ for the database, one NAT (environment != production).
environment       = "demo"
region            = "us-east-1"
db_instance_class = "db.t4g.micro"
db_multi_az       = false
app_desired       = 1
app_max           = 2
certificate_arn   = "" # HTTP on the load balancer's DNS name; add an ACM certificate for HTTPS
