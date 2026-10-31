# TicketHub

Ticket booking site (Node.js + PostgreSQL + Nginx) deployed on Kubernetes with CRI-O.
Terraform builds the AWS servers, Ansible configures them, Jenkins ships every change,
Traefik serves it over HTTPS, Prometheus and Grafana monitor it.

Replace `srinathdoc260194` (Docker Hub user) and `srinathahir.co.in` (domain) if yours differ.

## 0. Push this repository to GitHub

    git init && git add . && git commit -m "TicketHub"
    git branch -M main
    git remote add origin https://github.com/<your-github-user>/tickethub.git
    git push -u origin main

## 1. Test locally

    docker compose up --build -d
    # open http://localhost:8080, register, book seats
    docker compose down

## 2. Build an image from the Git repository (Dockerfile.git variants)

    docker build -f backend/Dockerfile.git  --build-arg REPO_URL=https://github.com/<user>/tickethub.git -t <dockerhub-user>/tickethub-backend:v1 .
    docker build -f frontend/Dockerfile.git --build-arg REPO_URL=https://github.com/<user>/tickethub.git -t <dockerhub-user>/tickethub-frontend:v1 .
    docker login -u <dockerhub-user>
    docker push <dockerhub-user>/tickethub-backend:v1
    docker push <dockerhub-user>/tickethub-frontend:v1

The repository must be public, or pass a token in REPO_URL.
The Jenkins pipeline uses the plain Dockerfiles (they copy the checked-out workspace).

## 3. Terraform: create the infrastructure

    cd terraform
    cp terraform.tfvars.example terraform.tfvars    # edit key_name, private_key_path, my_ip_cidr
    terraform init
    terraform validate
    terraform apply
    terraform output                                # note ingress_ip, jenkins_url, master_public_ip
    cd ..

## 4. Ansible: configure the servers

    cd ansible
    pip install ansible                             # the full package
    ansible all -m ping                             # retry if SSH is not ready yet
    ansible-playbook cluster.yml                    # CRI-O, kubeadm, Calico, join workers
    ansible-playbook jenkins.yml                    # Jenkins, Docker, kubectl (prints first password)
    cd ..

## 5. Deploy the application (run on the master)

    scp -i ~/.ssh/<key>.pem -r k8s monitoring ubuntu@<master_public_ip>:~/
    ssh -i ~/.ssh/<key>.pem ubuntu@<master_public_ip>

    # first push the v1 images (section 2), then:
    kubectl apply -f k8s/00-namespace.yaml
    ./k8s/create-secret.sh
    kubectl apply -f k8s/02-storage.yaml -f k8s/03-database.yaml
    kubectl apply -f k8s/04-backend.yaml -f k8s/05-frontend.yaml
    kubectl -n tickets get pods

## 6. DNS, ingress and HTTPS (still on the master)

In GoDaddy create A records `tickets` and `grafana` pointing to the `ingress_ip` output.

    curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 && bash get_helm.sh
    helm repo add traefik https://traefik.github.io/charts
    helm repo add jetstack https://charts.jetstack.io
    helm repo update
    helm install traefik traefik/traefik -n traefik --create-namespace -f k8s/traefik-values.yaml
    helm install cert-manager jetstack/cert-manager -n cert-manager --create-namespace --set crds.enabled=true
    # edit the email address in k8s/cluster-issuer.yaml first
    kubectl apply -f k8s/cluster-issuer.yaml
    kubectl apply -f k8s/06-ingress.yaml
    kubectl -n tickets get certificate -w           # wait for READY True
    # open https://tickets.srinathahir.co.in

## 7. Jenkins CI/CD

1. Open the `jenkins_url` output, unlock with the password Ansible printed, install suggested plugins.
2. Manage Jenkins > Credentials > Global: add `dockerhub-creds` (username + Docker Hub access token)
   and `kubeconfig` (Secret file: `ansible/admin.conf`).
3. New Item > Pipeline > "Pipeline script from SCM" > Git > your GitHub URL > branch `*/main` > Script Path `Jenkinsfile`.
4. Build Now once; afterwards every `git push` is picked up within two minutes (Poll SCM).

## 8. Monitoring

    helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
    helm repo update
    helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace -f monitoring/values.yaml
    kubectl apply -f monitoring/servicemonitor.yaml -f monitoring/alerts.yaml
    # open https://grafana.srinathahir.co.in (user admin, password from monitoring/values.yaml)

## 9. Hardening (optional)

    kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
    kubectl -n kube-system patch deployment metrics-server --type=json -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
    kubectl apply -f k8s/hpa.yaml -f k8s/networkpolicy.yaml -f k8s/db-backup-cronjob.yaml

## 10. Clean up

    cd terraform && terraform destroy

## Notes

- Versions are pinned to Kubernetes/CRI-O v1.29 and Calico v3.27.3 (variables at the top of `ansible/cluster.yml`).
- Ingress NGINX was retired in March 2026, which is why this project uses Traefik.
- Never commit `terraform.tfvars`, `*.pem`, `ansible/admin.conf` or passwords (see `.gitignore`).
