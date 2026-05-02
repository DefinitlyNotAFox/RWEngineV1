export async function onRequestPost(context) {
  return Response.json({
    success: true,
    message: "RWEngine API is working."
  });
}
