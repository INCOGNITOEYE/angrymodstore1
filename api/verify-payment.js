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
    const { order_id } = req.body || {};

    if (
      typeof order_id !== "string" ||
      !/^fg_[A-Za-z0-9_-]+$/.test(order_id)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid order_id"
      });
    }

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

    const dbHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json"
    };

    // Find the order created by our own store.
    const orderUrl = new URL("/rest/v1/store_orders", SUPABASE_URL);
    orderUrl.searchParams.set("order_id", `eq.${order_id}`);
    orderUrl.searchParams.set(
      "select",
      "order_id,duration,amount,payment_status"
    );
    orderUrl.searchParams.set("limit", "1");

    const orderResponse = await fetch(orderUrl, {
      headers: dbHeaders
    });

    if (!orderResponse.ok) {
      return res.status(502).json({
        success: false,
        error: "Could not load store order"
      });
    }

    const orders = await orderResponse.json();
    const order = orders[0];

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Store order not found"
      });
    }

    // If already paid, do not allocate another key.
    if (order.payment_status === "paid") {
      return res.status(409).json({
        success: false,
        error: "Order already processed"
      });
    }

    if (order.payment_status !== "pending") {
      return res.status(409).json({
        success: false,
        error: "Order is not pending"
      });
    }

    // Ask FamGateway for authoritative server-side verification.
    const verifyUrl = new URL(
      "https://famgateway.in/api/verify-order.php"
    );
    verifyUrl.searchParams.set("order_id", order_id);
    verifyUrl.searchParams.set("api_key", FAMGATE_API_KEY);

    const gatewayResponse = await fetch(verifyUrl, {
      headers: { Accept: "application/json" }
    });

    const gatewayResult = await gatewayResponse.json();
    const payment = gatewayResult?.data || gatewayResult;

    if (!gatewayResponse.ok) {
      return res.status(502).json({
        success: false,
        error: "Payment provider verification failed"
      });
    }

    const isPaid =
      payment?.is_paid === true ||
      (
        gatewayResult?.status === "success" &&
        payment?.status === "success"
      );

    if (!isPaid) {
      return res.status(200).json({
        success: false,
        payment_status: payment?.status || "pending",
        message: "Payment has not been confirmed. No key was issued."
      });
    }

    if (payment?.order_id && payment.order_id !== order_id) {
      return res.status(400).json({
        success: false,
        error: "Payment order mismatch"
      });
    }

    const paidAmount = Number(payment?.amount);
    const expectedAmount = Number(order.amount);

    if (
      !Number.isFinite(paidAmount) ||
      !Number.isFinite(expectedAmount) ||
      Math.abs(paidAmount - expectedAmount) > 0.001
    ) {
      return res.status(409).json({
        success: false,
        error: "Payment amount mismatch. Contact support."
      });
    }

    // Atomic database fulfillment must be configured before this endpoint
    // can issue a license key. Until then, fail safely.
    return res.status(503).json({
      success: false,
      payment_verified: true,
      error: "Payment verified, but license fulfillment is not configured yet.",
      message: "No license key was issued. Configure the secure database fulfillment function next."
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
