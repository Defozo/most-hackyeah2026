import { generateKeyPairSync,sign,webcrypto } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { verifyBundleSignature } from './signature';

const keys=generateKeyPairSync('ed25519');
const spki=new Uint8Array(keys.publicKey.export({type:'spki',format:'der'}));
const message=new TextEncoder().encode('{"modelRevision":1,"organizationId":"synthetic-test"}');
const signature=new Uint8Array(sign(null,message,keys.privateKey));
const native=webcrypto.subtle as unknown as SubtleCrypto;
const unsupported=()=>({importKey:vi.fn().mockRejectedValue(new DOMException('Unrecognized algorithm','NotSupportedError')),verify:vi.fn()}) as unknown as Pick<SubtleCrypto,'importKey'|'verify'>;

describe('Ed25519 signed bundle compatibility',()=>{
  it('verifies a Node-generated signature with native WebCrypto',async()=>{
    expect(await verifyBundleSignature(spki,signature,message,native)).toBe(true);
  });
  it('verifies the same signature when native Ed25519 is unsupported',async()=>{
    expect(await verifyBundleSignature(spki,signature,message,unsupported())).toBe(true);
  });
  it('rejects a modified manifest, modified signature and a different public key in both implementations',async()=>{
    const alteredMessage=message.slice();alteredMessage[0]^=1;
    const alteredSignature=signature.slice();alteredSignature[10]^=1;
    const otherKey=new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}));
    for(const provider of [native,unsupported()]){
      expect(await verifyBundleSignature(spki,signature,alteredMessage,provider)).toBe(false);
      expect(await verifyBundleSignature(spki,alteredSignature,message,provider)).toBe(false);
      expect(await verifyBundleSignature(otherKey,signature,message,provider)).toBe(false);
    }
  });
  it('uses strict verification and rejects a small-order identity public key and signature',async()=>{
    const identityKey=spki.slice();identityKey.fill(0,12);identityKey[12]=1;
    const identitySignature=new Uint8Array(64);identitySignature[0]=1;
    expect(await verifyBundleSignature(identityKey,identitySignature,message,unsupported())).toBe(false);
  });
  it('rejects noncanonical SPKI, wrong algorithm, trailing bytes and wrong signature length before crypto',async()=>{
    const subtle=unsupported();const wrongAlgorithm=spki.slice();wrongAlgorithm[8]=0x6e;
    const padding=spki.slice();padding[11]=1;
    for(const key of [wrongAlgorithm,padding,spki.slice(1),Uint8Array.from([...spki,0])])expect(await verifyBundleSignature(key,signature,message,subtle)).toBe(false);
    expect(await verifyBundleSignature(spki,signature.slice(1),message,subtle)).toBe(false);expect(subtle.importKey).not.toHaveBeenCalled();
  });
  it('does not override a native false result or mask a non-support-related crypto error',async()=>{
    const subtle={importKey:vi.fn().mockResolvedValue({}),verify:vi.fn().mockResolvedValue(false)} as unknown as Pick<SubtleCrypto,'importKey'|'verify'>;
    expect(await verifyBundleSignature(spki,signature,message,subtle)).toBe(false);
    const failed={importKey:vi.fn().mockRejectedValue(new DOMException('Invalid key','DataError')),verify:vi.fn()} as unknown as Pick<SubtleCrypto,'importKey'|'verify'>;
    await expect(verifyBundleSignature(spki,signature,message,failed)).rejects.toMatchObject({name:'DataError'});
  });
  it('falls back if verification itself, after import, reports missing algorithm support',async()=>{
    const subtle={importKey:vi.fn().mockResolvedValue({}),verify:vi.fn().mockRejectedValue(new DOMException('Unsupported','NotSupportedError'))} as unknown as Pick<SubtleCrypto,'importKey'|'verify'>;
    expect(await verifyBundleSignature(spki,signature,message,subtle)).toBe(true);
  });
});
