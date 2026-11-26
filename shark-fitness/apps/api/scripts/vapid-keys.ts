/**
 * Prints a fresh VAPID key pair for Web Push:
 *
 *   pnpm -F @shark/api vapid:keys
 *
 * Put the values in the server's environment (never in the repository). The
 * private key signs every push this deployment sends; rotating it means every
 * phone has to switch notifications on again.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(
  `SHARK_VAPID_PUBLIC_KEY=${publicKey}\nSHARK_VAPID_PRIVATE_KEY=${privateKey}\nSHARK_VAPID_SUBJECT=mailto:you@your-gym.example\n`,
);
