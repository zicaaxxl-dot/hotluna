# Hotluna

Cópia local do site público, com checkout PIX pela VizzionPay, API própria e painel admin. Pronto para o Render. Não publique o arquivo `.env`.

## Rodar

```bash
npm install
node server.mjs
```

- Site: http://127.0.0.1:4173/
- Admin: http://127.0.0.1:4173/admin

A senha do admin e a chave da API estão no `.env` (`ADMIN_PASSWORD` e `HOTLUNA_API_KEY`). As chaves da VizzionPay também ficam só nesse arquivo.

## API de PIX

O checkout do site chama o servidor, e o servidor chama `POST https://app.vizzionpay.com.br/api/v1/gateway/pix/receive` com `x-public-key` e `x-secret-key`.

Para gerar uma cobrança de outro sistema:

```bash
curl -X POST http://127.0.0.1:4173/api/v1/pix/create \
  -H "content-type: application/json" \
  -H "x-api-key: $HOTLUNA_API_KEY" \
  -d '{"amount":21.87,"payerName":"Maria Silva","payerDocument":"12345678909","payerEmail":"maria@email.com","payerPhone":"11999999999","description":"Assinatura Luna Harts"}'
```

Consulta:

```bash
curl "http://127.0.0.1:4173/api/v1/pix/status?transactionId=ID" \
  -H "x-api-key: $HOTLUNA_API_KEY"
```

Webhook da VizzionPay: `https://SEU-DOMINIO/api/v1/pix/webhook`

Em `http://127.0.0.1` o servidor não envia `callbackUrl` (o firewall da VizzionPay bloqueia URL local). A confirmação local usa consulta espaçada. No Render, com HTTPS público, o webhook é registrado.

O checkout do site só aceita os preços dos planos (com ou sem o pack extra). A API com `x-api-key` aceita outros valores entre R$ 1 e R$ 10.000.

## Render

O arquivo `render.yaml` descreve o serviço. No painel do Render, cadastre:

- `VIZZION_PUBLIC_KEY`
- `VIZZION_SECRET_KEY`
- `ADMIN_PASSWORD`
- `HOTLUNA_API_KEY`

`PUBLIC_BASE_URL` pode ficar vazio: no Render o servidor usa `RENDER_EXTERNAL_URL` para montar o webhook. As cobranças ficam em disco (`DATA_DIR=/var/data`).

## Usuário da API Luna

O site do cliente usa um par próprio da Luna, `LUNA_CLIENT_ID` e `LUNA_CLIENT_SECRET`. Esse par aparece em `/paineladmin2`, no botão **Gerar Novo Par de Chaves**. A chave antiga `ci_e4e626ce6b68908ecb3be4d8` foi recusada de propósito.

```bash
curl -X POST http://127.0.0.1:4173/api/v1/pix/create \
  -H "content-type: application/json" \
  -H "ci: $LUNA_CLIENT_ID" \
  -H "cs: $LUNA_CLIENT_SECRET" \
  -d '{"amount":21.87,"payerName":"Maria Silva","payerDocument":"12345678909","payerEmail":"maria@email.com","payerPhone":"11999999999","description":"Assinatura"}'
```

A chave pública e a privada da Vizzion também continuam aceitas em `ci`/`cs`. As cobranças do site ficam em `/admin`.
