FROM python:3.10-slim

WORKDIR /app

# Install system dependencies (build-essential needed for any C compilations like greenlet, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy and install requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY . .

EXPOSE 8000

# Command to run database initialization, pipeline generation, and start FastAPI server
# First start builds the Edinburgh data and model (a few minutes); later starts reuse them.
# Run the experiments separately: docker compose exec backend python run_pipeline.py --experiments smoke
CMD python run_pipeline.py --experiments none && python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
