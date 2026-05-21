# Kubernetes deployment

Self-hosted manifests for k3s / kind / any vanilla cluster.

## Quickstart

```bash
# Build & load images into your cluster (kind example).
docker build -t llm-logger/ingestion:dev -f ingestion/Dockerfile .
docker build -t llm-logger/chatbot:dev   -f chatbot/Dockerfile .
docker build -t llm-logger/frontend:dev  -f frontend/Dockerfile .
kind load docker-image llm-logger/ingestion:dev llm-logger/chatbot:dev llm-logger/frontend:dev

# 1) namespace + secrets (edit values first)
kubectl apply -f namespace.yaml
kubectl apply -f secrets.yaml

# 2) data plane
kubectl apply -f postgres.yaml
kubectl apply -f redis.yaml

# 3) app
kubectl apply -f ingestion.yaml
kubectl apply -f consumer.yaml
kubectl apply -f chatbot.yaml
kubectl apply -f frontend.yaml
```

Frontend exposes port 5173 via a NodePort. For production, swap to an Ingress.
