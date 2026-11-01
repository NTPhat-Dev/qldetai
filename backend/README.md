# qldetai backend

Koa API service for the project.

## Run

```sh
npm install
npm run dev
```

Copy `.env.example` to `.env`, then set `DATABASE_URL` to your PostgreSQL database connection string. Never commit `.env`.

The API listens on port `3000` by default. Set `PORT` to use a different port.

- `GET http://localhost:3000/api/health` checks that the API is running.
- `GET http://localhost:3000/api/db-check` checks the database connection and whether the `qldetai` schema exists.
