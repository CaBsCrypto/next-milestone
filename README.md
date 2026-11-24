# Next Milestone

Financia la próxima entrega de una demo que ya puedes probar. El equipo cobra por el hito aprobado y, si el acuerdo termina antes de completar las entregas, cada aportante puede reclamar su parte del saldo pendiente.

Caption Lab es una campaña ficticia en Solana Devnet. El primer hito entrega un clip de clase con subtítulos sincronizados en español. El segundo propone exportar WebVTT desde el producto y vence. La prueba de aceptación deposita **600 y 400**, desembolsa **300** y devuelve **420 y 280**. Todos los montos del proyecto son tokens de prueba.

## Abrir la demo

La [ficha pública](https://next-milestone-chi.vercel.app/) abre sin wallet. Cuando está configurada con el manifiesto de Devnet, la ficha lee el programa y enlaza las direcciones y firmas a Explorer. El estado de ejemplo sirve para revisar el diseño antes de desplegar. El clip original también está disponible en [`web/public/evidence/`](web/public/evidence/).

| Dato | Cómo verificarlo |
| --- | --- |
| Program ID de la compilación | [Consultar estado del programa en Explorer (Devnet)](https://explorer.solana.com/address/G5TYizzLmGWWbcEYhUgz8pdZupqgHKRkiKszz3UUPaHk?cluster=devnet) |
| Campaign, vault, mint y firmas | `web/public/demo-manifest.json`, generado por la semilla después de confirmar las transacciones |
| IDL de la web | `web/public/devnet-idl.json`, copiada desde la compilación usada para el despliegue |

## Compilar y probar

Usa Linux o WSL con Anchor **1.2.2**, Agave **4.1.2**, Rust **1.96.0** y Node **24**. En Ubuntu x86-64, `bash ci/install-solana.sh` instala los binarios. Agrega el directorio `bin` y `solana-release/bin` de ese instalador a tu `PATH`, o usa el entorno incluido en `ci/Dockerfile`.

```bash
anchor build
cargo test --workspace --locked
npm ci --ignore-scripts --prefix scripts
npm run check --prefix scripts
npm run test:local --prefix scripts
npm ci --prefix web
npm run build --prefix web
npm run dev --prefix web
```

En Windows con Docker Desktop en modo Linux, PowerShell puede compilar el programa y ejecutar las pruebas. Agave 4.1.2 necesita las llamadas `io_uring`, por lo que el contenedor de prueba usa el perfil oficial de Docker con esas llamadas adicionales, red aislada y sin capacidades adicionales.

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

La suite local levanta su propio validador y comprueba estados, destinos, vencimientos y balances SPL. La aceptación local pasó en ambos órdenes de reclamo, con saldo final registrado de cero. Las pruebas también cubren el pago de los dos hitos, la meta fallida, el redondeo, la disputa, el silencio del revisor y del árbitro y el rechazo de cobros duplicados. La hora para el programa viene de `Clock`. Una aprobación válida deja el hito pagable hasta que se ejecute su desembolso. Las cantidades se manejan en unidades atómicas por toda la ruta.

## Desplegar en Devnet y recrear la campaña

Usa una autoridad exclusiva de Devnet con SOL de prueba y el keypair que corresponde al Program ID. El proyecto conserva la autoridad de upgrade en la wallet de despliegue. Mantén las claves fuera del control de versiones. Para poder reanudar un despliegue, crea un keypair temporal separado para `DEVNET_BUFFER`. Los despliegues de este proyecto usan el RPC `https://api.devnet.solana.com`.

```bash
solana program deploy --url https://api.devnet.solana.com \
  --keypair "$DEVNET_PAYER" --program-id "$DEVNET_PROGRAM_KEYPAIR" \
  --buffer "$DEVNET_BUFFER" target/deploy/next_milestone.so

npm run seed:devnet --prefix scripts -- --wallet "$DEVNET_PAYER" \
  --evidence-base 'https://next-milestone-chi.vercel.app/evidence/' --include-dispute

npm run build --prefix web
```

Primero publica `web/` como proyecto Vite en Vercel para servir los archivos de evidencia. Repite el despliegue web después de generar el manifiesto e IDL. La semilla comprueba que el cluster es Devnet. Revisa `demo-manifest.json` antes de publicar y verifica sus firmas en Explorer.

El workflow **Verify Next Milestone** ejecuta las pruebas en Ubuntu. Desde `main`, el disparo manual con `deploy_devnet` puede desplegar el programa y adjuntar los dos archivos públicos. Configura los secretos `DEVNET_PAYER_KEYPAIR` y `DEVNET_PROGRAM_KEYPAIR` únicamente con los JSON de Devnet, y pasa la URL HTTPS de `evidence/` en `evidence_base`.

## Cómo se protege el saldo pendiente

- `Campaign` fija los términos económicos, mint y roles. El estado de cada `Milestone` determina si se puede revisar, objetar, ejecutar o vencer. `Contribution` conserva cuánto aportó cada wallet y si ya reclamó.
- Los depósitos y el registro de aportes se confirman en la misma transacción. Los desembolsos tienen destinatario fijo. La aprobación o cancelación se resuelve en el programa y la bóveda la controla una PDA.
- Cuando una campaña termina con saldo pendiente, el programa congela el saldo contable. Calcula `floor(aporte × saldo pendiente / total aportado)` en unidades atómicas. Redondeos y reembolsos sin reclamar quedan en la bóveda. Una transferencia ajena a la campaña queda fuera del cálculo.
- El arbitraje de la demo usa una wallet designada y un expediente por hito. Las decisiones del árbitro y el vencimiento quedan en Solana. En un piloto real, la independencia del árbitro y el proceso de revisión requieren validación con participantes.

## Procedencia

El documento maestro de Next Milestone precede al evento. Este workspace comenzó sin commits. El código de Next Milestone y la campaña ficticia se prepararon con Codex, los SDK oficiales de Anchor y Solana, y las dependencias que figuran en los lockfiles. El clip usa una lección y subtítulos originales, narración sintética local y un render reproducible mediante `python demo/render_evidence.py` en Windows con Pillow y FFmpeg con libflite. Los commits fechados durante el evento deben identificarse en la ficha de envío. Consulta [`demo/submission.md`](demo/submission.md) para preparar esa ficha.
