# Next Milestone

Next Milestone es una plataforma de crowdfunding por hitos en Solana. Cualquier equipo puede publicar su propio video y speech, definir dos entregables y compartir una ficha para reunir aportes de varias personas.

La recaudación completa activa el primer hito. Los tokens permanecen en una bóveda controlada por el programa. El revisor designado valida la evidencia y libera el importe de cada entrega. Si la campaña termina con saldo pendiente, cada aportante puede reclamar la parte que le corresponde.

## Crear y compartir una campaña

1. Abre [Next Milestone](https://next-milestone-chi.vercel.app/) y elige **Crear campaña**.
2. Escribe el speech y el nombre del equipo. Elige tu archivo MP4 de hasta 100 MB. Define el entregable, el criterio de aprobación y el importe de cada hito. Designa una wallet revisora distinta de la del creador.
3. Revisa la ficha y conecta tu wallet de Devnet. La publicación incluye la carga de la propuesta y una transacción que crea la campaña y registra el SHA-256 de su ficha.
4. Comparte `/campanas/<dirección>`. Los visitantes pueden leer el speech y reproducir el video sin wallet. Los aportes, pagos y reclamos confirmados enlazan a Solana Explorer.

El creador adjunta la evidencia desde la ficha. El revisor aprueba y libera en una firma, o solicita la subsanación prevista. Las cantidades se muestran en tokens de prueba y se registran en unidades atómicas. El mint común es un SPL de Devnet de cero decimales.

## Compilar y probar

Usa Linux o WSL con Anchor **1.2.2**, Agave **4.1.2**, Rust **1.96.0** y Node **24**. En Ubuntu x86-64, `bash ci/install-solana.sh` instala los binarios. Agrega los directorios `bin` y `solana-release/bin` del instalador a tu `PATH`.

```bash
anchor build
cargo test --workspace --locked
npm ci --ignore-scripts --prefix scripts
npm run test:local --prefix scripts
npm ci --prefix web
npm test --prefix web
npm run build --prefix web
npm run dev --prefix web
```

Para comprobar las Functions con configuración de proyecto, usa `vercel dev` desde `web/`. `npm run dev` sirve la interfaz y permite revisar el formulario y su vista previa.

En Windows con Docker Desktop en modo Linux, usa PowerShell. El perfil de prueba habilita las llamadas `io_uring` que necesita Agave y ejecuta el validador con red aislada.

```powershell
docker build -f ci/Dockerfile -t next-milestone/solana-toolchain:1.2.2 .
docker run --rm --mount "type=bind,source=$($PWD.Path),target=/workspace" `
  --mount 'type=volume,source=next-milestone-scripts-deps,target=/workspace/scripts/node_modules' `
  next-milestone/solana-toolchain:1.2.2 bash -c 'set -e; anchor build; npm ci --ignore-scripts --prefix scripts'
$validatorProfilePath = & ./ci/docker-validator-profile.ps1
docker run --rm --network none --cap-drop ALL --security-opt "seccomp=$validatorProfilePath" `
  --mount "type=bind,source=$($PWD.Path),target=/workspace,readonly" `
  --mount 'type=volume,source=next-milestone-scripts-deps,target=/workspace/scripts/node_modules,readonly' `
  next-milestone/solana-toolchain:1.2.2 npm run test:local --prefix scripts
```

La aceptación comprueba que la creación y el registro de la propuesta se procesen juntos. El escenario de fondos concilia **600 + 400** aportados, **300** pagados y **420 + 280** devueltos, en ambos órdenes de reclamo. También cubre dos pagos consecutivos, meta fallida, plazos y cobros duplicados. Las pruebas de la API comprueban los permisos de carga y el hash de los documentos.

## Activar Devnet y el almacenamiento

El [Program ID de la compilación](https://explorer.solana.com/address/G5TYizzLmGWWbcEYhUgz8pdZupqgHKRkiKszz3UUPaHk?cluster=devnet) se configura también en `web/.env.example`. La web usa `web/public/devnet-idl.json`, generada con `anchor build`. Tras cambiar el programa, copia la IDL generada y valida la comparación de CI.

Despliega con una autoridad exclusiva de Devnet financiada con SOL de prueba. El keypair de programa debe coincidir con el Program ID. Usa un keypair de buffer aparte para poder reanudar el despliegue.

```bash
solana program deploy --url https://api.devnet.solana.com \
  --keypair "$DEVNET_PAYER" --program-id "$DEVNET_PROGRAM_KEYPAIR" \
  --buffer "$DEVNET_BUFFER" target/deploy/next_milestone.so

npm run provision:devnet --prefix scripts -- --wallet "$DEVNET_PAYER" \
  --recipient "$TEST_CONTRIBUTOR_A" --recipient "$TEST_CONTRIBUTOR_B"
```

Usa el `VITE_SOLANA_MINT` impreso en el proyecto de Vercel y vuelve a compilar la web. Para financiar otras wallets o repetir el aprovisionamiento usa `--mint <dirección>` con la misma autoridad. Cada wallet que firma también necesita SOL de Devnet para las comisiones.

Conecta un almacén público de Vercel Blob al proyecto `web/`. El servidor acepta `BLOB_READ_WRITE_TOKEN` o una conexión OIDC con `BLOB_STORE_ID` y `UPLOAD_CHALLENGE_SECRET`. Conserva esas credenciales en las variables privadas de Vercel. El navegador pide autorización firmando un mensaje vinculado a la campaña y sube el archivo directamente al almacén. Las Functions devuelven la URL y hash de los documentos que registra Solana.

El workflow **Verify Next Milestone** compila el programa, compara la IDL, ejecuta las pruebas y valida la web. Su ejecución manual desde `main` puede desplegar en Devnet con los secretos de pruebas `DEVNET_PAYER_KEYPAIR` y `DEVNET_PROGRAM_KEYPAIR`. Usa `test_mint` para conservar el mint de una ejecución anterior.

## Procedencia

El documento maestro de Next Milestone precede a Dev3Pack. Este repositorio contiene la implementación de la bóveda, la web y las pruebas realizadas con Codex y los SDK de Anchor, Solana y Vercel. La primera campaña pública tendrá el video y el speech aportados por su propio equipo.
