/**
 * Sinh cặp khoá Ed25519 cho ag-farm ticket.
 * Chạy: yarn workspace @ag-farm/api keys:generate
 * In ra PEM dạng thường và dạng escaped (một dòng, \n) để copy vào .env.
 */
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function escape(pem: string): string {
  return pem.replace(/\n/g, '\\n');
}

console.log('=== Ed25519 Ticket Keys ===\n');
console.log('FARM_TICKET_PRIVATE_KEY (PEM):');
console.log(privateKey);
console.log('FARM_TICKET_PUBLIC_KEY (PEM):');
console.log(publicKey);
console.log('--- Dan vao .env (escaped) ---');
console.log(`FARM_TICKET_PRIVATE_KEY="${escape(privateKey)}"`);
console.log(`FARM_TICKET_PUBLIC_KEY="${escape(publicKey)}"`);
