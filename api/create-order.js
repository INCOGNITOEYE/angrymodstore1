export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const {
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      FAMGATE_API_KEY
    } = process.env;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FAMGATE_API_KEY) {
      return res.status(500).json({
        success: false,
        error: "Server configuration incomplete"
      });
    }

    const duration = req.body?.duration;
    const allowedDurations = ["1 Day", "7 Days", "15 Days", "30 Days"];

    if (typeof duration !== "string" || !allowedDurations.includes(duration)) {
      return res.status(400).json({
        success: false,
        error: "Invalid package duration"
      });
    }

    const dbHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    const packageUrl = new URL("/rest/v1/packages", SUPABASE_URL);
    packageUrl.searchParams.set("duration", `eq.${duration}`);
    packageUrl.searchParams.set("active", "eq.true");
    packageUrl.searchParams.set("select", "duration,price");
    packageUrl.searchParams.set("limit", "1");

    const packageResponse = await fetch(packageUrl, {
      headers: dbHeaders
    });

    if (!packageResponse.ok) {
      console.error("Package lookup failed:", packageResponse.status);
      return res.status(502).json({
        success: false,
        error: "Could not load package price"
      });
    }

    const packages = await packageResponse.json();
    const selectedPackage = packages[0];

    if (
      !selectedPackage ||
      !Number.isFinite(Number(selectedPackage.price)) ||
      Number(selectedPackage.price) <= 0
    ) {
      return res.status(404).json({
        success: false,
        error: "Active package not found"
      });
    }

    const amount = Number(selectedPackage.price);

    const gatewayResponse = await fetch(
      "https://famgateway.in/api/create-order",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Api-Key": FAMGATE_API_KEY
        },
        body: JSON.stringify({
          amount,
          customer_name: "AngryMod Customer"
        })
      }
    );

    const gatewayResult = await gatewayResponse.json();

    const gatewayOrder = gatewayResult?.data || gatewayResult;
    const orderId = gatewayOrder?.order_id;
    const checkoutUrl = gatewayOrder?.checkout_url;

    if (
      !gatewayResponse.ok ||
      gatewayResult?.status === "error" ||
      typeof orderId !== "string" ||
      typeof checkoutUrl !== "string"
    ) {
      console.error(
        "FamGateway order creation failed:",
        gatewayResponse.status,
        gatewayResult?.message || gatewayResult?.error || "Unexpected response"
      );

      return res.status(502).json({
        success: false,
        error: "Payment order creation failed"
      });
    }

    let parsedCheckoutUrl;

    try {
      parsedCheckoutUrl = new URL(checkoutUrl);
    } catch {
      return res.status(502).json({
        success: false,
        error: "Invalid checkout URL"
      });
    }

    if (
      parsedCheckoutUrl.protocol !== "https:" ||
      parsedCheckoutUrl.hostname !== "famgateway.in"
    ) {
      return res.status(502).json({
        success: false,
        error: "Unexpected checkout URL"
      });
    }

    const orderResponse = await fetch(
      new URL("/rest/v1/store_orders", SUPABASE_URL),
      {
        method: "POST",
        headers: {
          ...dbHeaders,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          order_id: orderId,
          duration,
          amount,
          payment_status: "pending"
        })
      }
    );

    if (!orderResponse.ok) {
      console.error(
        "Order save failed:",
        orderResponse.status,
        (await orderResponse.text()).slice(0, 300)
      );

      return res.status(502).json({
        success: false,
        error: "Could not save payment order"
      });
    }

    return res.status(200).json({
      success: true,
      order_id: orderId,
      duration,
      amount,
      checkout_url: checkoutUrl,
      message: "Order created; payment is not yet confirmed."
    });
  } catch (error) {
    console.error("Create order error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
