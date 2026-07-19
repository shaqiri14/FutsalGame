# Futsal Game — Protótipo

Jogo de futebol de mesa (estilo Subbuteo) em HTML5 Canvas, servido por um pequeno servidor Node/Express — pronto para o Railway.

## Como jogar
- **1 dedo / rato**: arrasta o boneco da tua cor para trás (estilingue) e larga.
- **2 dedos** (touch): desliza na direção do chuto — a velocidade do gesto define a força.
- Marca golo passando a bola pela baliza. Placar e vez alternam automaticamente.

## Estrutura
```
futsal-game/
├── server.js        → servidor Express que serve o jogo
├── package.json
├── public/
│   └── index.html   → jogo completo (HTML + CSS + JS)
└── README.md
```

## Testar localmente
```bash
npm install
npm start
```
Abre `http://localhost:3000`.

## Publicar

### 1. GitHub
```bash
git init
git add .
git commit -m "Futsal Game — protótipo inicial"
git branch -M main
git remote add origin https://github.com/<o-teu-user>/futsal-game.git
git push -u origin main
```
Podes deixar o repositório **privado** — o Railway liga-se diretamente ao GitHub e não precisa que seja público.

### 2. Railway
1. Vai a [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Escolhe o repositório `futsal-game` (autoriza o acesso ao GitHub se for a primeira vez).
3. O Railway deteta o `package.json` e o `npm start` automaticamente — não precisas de configurar nada.
4. Em **Settings → Networking**, gera um domínio público (`Generate Domain`).
5. Fica disponível em algo como `https://futsal-game-production.up.railway.app`.

Sempre que fizeres `git push` para o `main`, o Railway faz redeploy automático — tal como já fazes no Booklys.

## Próximos passos sugeridos
- Ligar por WebSocket (Socket.io) para dois jogadores reais em tempo real.
- Contas de utilizador + histórico de vitórias/derrotas/empates em PostgreSQL.
- Ligas e torneios (tabelas de classificação, chaves eliminatórias).
