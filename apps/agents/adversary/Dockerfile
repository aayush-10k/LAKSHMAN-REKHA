FROM python:3.11-slim

WORKDIR /app

COPY apps/agents/adversary/pyproject.toml ./
# No extra deps needed for the deterministic library

COPY apps/agents/adversary/ ./

ENV ADVERSARY_PORT=4300
ENV CORE_URL=http://core:4000

EXPOSE 4300

CMD ["python", "runner.py"]
