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
      order_id.length > 128 ||
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

    // Load the original order and expected amount from our database.
    const orderUrl = new URL("/rest/v1/store_orders", SUPABASE_URL);
    orderUrl.searchParams.set("order_id", `eq.${order_id}`);
    orderUrl.searchParams.set(
      "select",
      "order_id,duration,amount,payment_status,license_key_id"
    );
    orderUrl.searchParams.set("limit", "1");

    const orderResponse = await fetch(orderUrl, {
      headers: dbHeaders
    });

    if (!orderResponse.ok) {
      console.error("Order lookup failed:", orderResponse.status);
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

    // An already fulfilled order must not receive a second key.
    if (order.payment_status === "paid") {
      if (!order.license_key_id) {
        return res.status(409).json({
          success: false,
          error: "Paid order has no linked license key"
        });
      }

      const keyUrl = new URL("/rest/v1/license_keys", SUPABASE_URL);
      keyUrl.searchParams.set("id", `eq.${order.license_key_id}`);
      keyUrl.searchParams.set("select", "license_key");
      keyUrl.searchParams.set("limit", "1");

      const keyResponse = await fetch(keyUrl, {
        headers: dbHeaders
      });

      if (!keyResponse.ok) {
        return res.status(502).json({
          success: false,
          error: "Could not retrieve fulfilled license"
        });
      }

      const keys = await keyResponse.json();

      if (!keys[0]?.license_key) {
        return res.status(409).json({
          success: false,
          error: "License key not found for fulfilled order"
        });
      }

      return res.status(200).json({
        success: true,
        payment_status: "paid",
        order_id,
        license_key: keys[0].license_key
      });
    }

    if (order.payment_status !== "pending") {
      return res.status(409).json({
        success: false,
        error: "Order is not pending"
      });
    }

    // Verify directly with FamGateway using server-side credentials.
    const verifyUrl = new URL(
      "https://famgateway.in/api/verify-order.php"
    );
    verifyUrl.searchParams.set("order_id", order_id);

    const gatewayResponse = await fetch(verifyUrl, {
      headers: {
        Accept: "application/json",
        "X-Api-Key": FAMGATE_API_KEY
      }
    });

    let gatewayResult;

    try {
      gatewayResult = await gatewayResponse.json();
    } catch {
      return res.status(502).json({
        success: false,
        error: "Invalid payment provider response"
      });
    }

    if (!gatewayResponse.ok) {
      console.error("Gateway verification HTTP status:", gatewayResponse.status);
      return res.status(502).json({
        success: false,
        error: "Payment provider verification failed"
      });
    }

    const payment = gatewayResult?.data || gatewayResult;

    if (gatewayResult?.status !== "success") {
      if (
        gatewayResult?.status === "pending" ||
        gatewayResult?.status === "expired"
      ) {
        return res.status(200).json({
          success: false,
          payment_status: gatewayResult.status,
          message: "Payment is not confirmed. No license key was issued."
        });
      }

      return res.status(502).json({
        success: false,
        error: "Payment status could not be verified"
      });
    }

    // A successful status alone is insufficient: verify order ID and amount.
    if (payment?.order_id !== order_id) {
      return res.status(409).json({
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

    // Atomically claim exactly one key and mark the order paid.
    const fulfillmentResponse = await fetch(
      new URL("/rest/v1/rpc/fulfill_paid_order", SUPABASE_URL),
      {
        method: "POST",
        headers: {
          ...dbHeaders,
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          p_order_id: order_id,
          p_verified_amount: paidAmount
        })
      }
    );

    if (!fulfillmentResponse.ok) {
      console.error(
        "License fulfillment failed:",
        fulfillmentResponse.status,
        (await fulfillmentResponse.text()).slice(0, 300)
      );

      return res.status(503).json({
        success: false,
        payment_verified: true,
        error: "Payment verified, but license delivery is not complete. Contact support."
      });
    }

    const fulfillment = await fulfillmentResponse.json();
    const result = Array.isArray(fulfillment)
      ? fulfillment[0]
      : fulfillment;

    if (!result?.success || !result?.license_key) {
      return res.status(409).json({
        success: false,
        payment_verified: true,
        error: result?.error || "No license key was assigned",
        message: "Contact support if your payment was deducted."
      });
    }

    return res.status(200).json({
      success: true,
      payment_status: "paid",
      order_id,
      duration: order.duration,
      license_key: result.license_key,
      message: "Payment verified and license key assigned."
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
