export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  return res.status(501).json({
    error: "Payment API setup incomplete",
    message: "Payment processing will be enabled after database and gateway verification are configured."
  });
}
