export async function onRequest(context) {
  return Response.json({
    success: true,
    message: "RWEngine /api route is working.",
    method: context.request.method
  });
}
