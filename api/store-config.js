// Public store configuration endpoint. Secrets remain server-side in Vercel env vars.
export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Accept");

  if (req.method !== "GET") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ success: false, error: "Store configuration is incomplete" });
    }

    const headers = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json"
    };
    const packagesUrl = new URL("/rest/v1/packages", SUPABASE_URL);
    packagesUrl.searchParams.set("select", "duration,price,old_price,active");
    packagesUrl.searchParams.set("order", "id.asc");

    const stockUrl = new URL("/rest/v1/license_keys", SUPABASE_URL);
    stockUrl.searchParams.set("select", "duration,status");
    stockUrl.searchParams.set("status", "eq.available");
    stockUrl.searchParams.set("order", "id.asc");
    stockUrl.searchParams.set("limit", "10000");

    const [packagesResponse, stockResponse] = await Promise.all([
      fetch(packagesUrl, { headers }),
      fetch(stockUrl, { headers })
    ]);

    if (!packagesResponse.ok || !stockResponse.ok) {
      console.error("Store config lookup failed:", packagesResponse.status, stockResponse.status);
      return res.status(502).json({ success: false, error: "Could not load current prices and stock" });
    }

    const [packages, stock] = await Promise.all([packagesResponse.json(), stockResponse.json()]);
    const counts = new Map();
    for (const row of stock) counts.set(row.duration, (counts.get(row.duration) || 0) + 1);

    return res.status(200).json({
      success: true,
      packages: packages.map(p => ({
        duration: p.duration,
        price: Number(p.price),
        old_price: Number(p.old_price || 0),
        active: p.active === true,
        available_stock: counts.get(p.duration) || 0
      }))
    });
  } catch (error) {
    console.error("Store config error:", error?.message || "Unknown error");
    return res.status(500).json({ success: false, error: "Could not load store configuration" });
  }
}
