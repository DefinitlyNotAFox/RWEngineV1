export async function onRequestPost(context) {
  try {
    const request = context.request;
    const env = context.env;

    let body = {};

    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const action = body.action || "ping";

    if (action === "ping") {
      return Response.json({
        success: true,
        message: "RWEngine API is working."
      });
    }

    if (action === "dbTest") {
      if (!env.DB) {
        return Response.json(
          {
            success: false,
            message: "D1 binding missing. Expected binding name: DB."
          },
          { status: 500 }
        );
      }

      const now = Math.floor(Date.now() / 1000);

      await env.DB.prepare(
        `
        INSERT INTO app_meta (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
        `
      )
        .bind("db_test", "D1 connection works", now)
        .run();

      const row = await env.DB.prepare(
        `
        SELECT key, value, updated_at
        FROM app_meta
        WHERE key = ?
        `
      )
        .bind("db_test")
        .first();

      return Response.json({
        success: true,
        message: "D1 database read/write test successful.",
        row
      });
    }

    return Response.json(
      {
        success: false,
        message: `Unknown action: ${action}`
      },
      { status: 400 }
    );
  } catch (error) {
    return Response.json(
      {
        success: false,
        message: error.message || "Unexpected server error."
      },
      { status: 500 }
    );
  }
}
