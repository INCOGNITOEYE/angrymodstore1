export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { order_id } = req.body || {};

    if (!order_id || typeof order_id !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid order_id is required"
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const famGatewayKey = process.env.FAMGATE_API_KEY;

    if (!supabaseUrl || !supabaseKey || !famGatewayKey) {
      return res.status(500).json({
        success: false,
        error: "Server configuration incomplete"
      });
    }

    // Payment verification will be added next.
    // Never deliver a license key before server-side
    // payment verification confirms successful payment.

    return res.status(501).json({
      success: false,
      error: "Payment verification is not configured yet"
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Internal server error"
    });
  }
}
