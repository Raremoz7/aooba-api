const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || "seu_secret_aqui_para_desenvolvimento_local_aooba";

/**
 * Gera um token JWT com base nos dados do usuário do painel Admin.
 */
function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, bar_id: user.bar_id },
    SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
  );
}

/**
 * Middleware para proteger rotas. Verifica se o token JWT existe e é válido.
 */
function verifyToken(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Aoooba! Token não fornecido. Faça login.' });
  }

  jwt.verify(token, SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Aoooba! Seu token expirou ou é inválido.' });
    }
    
    // Injerta os dados decodificados no request para uso posterior
    req.user = decoded;
    next();
  });
}

/**
 * Middleware para validar a 'role' do usuário Admin (owner, manager, staff).
 */
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Ops! Você não tem permissão para esta ação.' });
    }
    next();
  };
}

module.exports = { generateToken, verifyToken, requireRole };
