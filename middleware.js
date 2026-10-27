// Vercel Routing Middleware : mot de passe sur tout le site si la variable QG_PASSWORD est définie
// (Vercel > Project > Settings > Environment Variables). Le navigateur affiche une fenêtre de connexion ;
// l'identifiant est libre, seul le mot de passe compte.
export const config = { matcher: "/:path*" };

export default function middleware(request) {
  const pwd = process.env.QG_PASSWORD;
  if (!pwd) return;                                   // pas de mot de passe configuré : site ouvert
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const given = decoded.slice(decoded.indexOf(":") + 1);
      if (given === pwd) return;                      // accès autorisé : la requête continue
    } catch (e) {
      // en-tête mal formé : on redemande le mot de passe
    }
  }
  return new Response("Mot de passe requis.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="QuantGuard", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" },
  });
}
