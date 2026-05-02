export async function onRequestPost() {
  return Response.json({
    success: true,
    message: "RWEngine API is working."
  });
}
