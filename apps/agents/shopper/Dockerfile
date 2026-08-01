FROM python:3.11-slim

WORKDIR /app

# Install uv for fast package management
RUN pip install uv

COPY apps/agents/shopper/pyproject.toml ./
RUN uv pip install --system langgraph httpx

COPY apps/agents/shopper/src/ ./src/

ENV SHOPPER_PORT=4200
ENV CORE_URL=http://core:4000
ENV VENDOR_URL=http://vendorsim:4100
ENV LEASE_RENEW_INTERVAL_MS=4000

EXPOSE 4200

CMD ["python", "-m", "src.runner"]
