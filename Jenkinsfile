pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  triggers {
    pollSCM('H/2 * * * *')
  }

  environment {
    REGISTRY = 'docker.io/srinathdoc260194'
    TAG      = "v${env.BUILD_NUMBER}"
  }

  stages {
    stage('Build images') {
      steps {
        // The backend Dockerfile runs "node --check", so a syntax error fails the build here
        sh 'docker build -t $REGISTRY/tickethub-backend:$TAG backend'
        sh 'docker build -t $REGISTRY/tickethub-frontend:$TAG frontend'
      }
    }

    stage('Push images') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'dockerhub-creds', usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
          sh 'echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin'
          sh 'docker push $REGISTRY/tickethub-backend:$TAG'
          sh 'docker push $REGISTRY/tickethub-frontend:$TAG'
        }
      }
    }

    stage('Deploy') {
      steps {
        withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG')]) {
          sh 'kubectl -n tickets set image deployment/backend backend=$REGISTRY/tickethub-backend:$TAG'
          sh 'kubectl -n tickets set image deployment/frontend frontend=$REGISTRY/tickethub-frontend:$TAG'
          script { env.DEPLOYED = 'true' }
          sh 'kubectl -n tickets rollout status deployment/backend --timeout=180s'
          sh 'kubectl -n tickets rollout status deployment/frontend --timeout=180s'
        }
      }
    }
  }

  post {
    failure {
      script {
        // Roll back only if this run had already changed the cluster
        if (env.DEPLOYED == 'true') {
          withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG')]) {
            sh 'kubectl -n tickets rollout undo deployment/backend || true'
            sh 'kubectl -n tickets rollout undo deployment/frontend || true'
          }
        }
      }
    }
    always {
      sh 'docker logout || true'
    }
  }
}
