# Start Redis
Start-Service Redis

# Window 1 - API
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:WORKER_API_SECRET='hirogen-secret-123'; `$env:WORKERS_URL='http://localhost:8000'; cd C:\Users\debas\sales-agent\packages\api; npm run dev"

# Window 2 - Web
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd C:\Users\debas\sales-agent\packages\web; npm run dev"

# Window 3 - Scrapers
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$env:WORKER_API_SECRET='hirogen-secret-123'; cd C:\Users\debas\sales-agent\packages\scrapers; python -m uvicorn main:app --reload --port 8000"