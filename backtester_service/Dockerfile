FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /app
COPY backtester_service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backtester_service/app ./app
COPY strategy_dsl ./strategy_dsl
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
