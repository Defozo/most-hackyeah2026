import { ed25519 } from '@noble/curves/ed25519.js';

// RFC 8410 DER SubjectPublicKeyInfo: id-Ed25519 with absent parameters,
// then a zero-padding BIT STRING containing exactly the 32-byte public key.
const spkiPrefix=Uint8Array.of(0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00);
type SignatureCrypto=Pick<SubtleCrypto,'importKey'|'verify'>;

export async function verifyBundleSignature(spki:Uint8Array,signature:Uint8Array,message:Uint8Array,subtle:SignatureCrypto=crypto.subtle):Promise<boolean>{
  if(spki.length!==spkiPrefix.length+32||!spkiPrefix.every((byte,index)=>spki[index]===byte)||signature.length!==64)return false;
  // Copy views so WebCrypto receives unshared, precisely bounded ArrayBuffers.
  const keyBytes=Uint8Array.from(spki),signatureBytes=Uint8Array.from(signature),messageBytes=Uint8Array.from(message);
  try{
    const key=await subtle.importKey('spki',keyBytes,{name:'Ed25519'},false,['verify']);
    return await subtle.verify('Ed25519',key,signatureBytes,messageBytes);
  }catch(error){
    // Invalid signatures, malformed data and other failures are never retried
    // through a different implementation. Only missing algorithm support is.
    if(!(error instanceof Error)||error.name!=='NotSupportedError')throw error;
    try{return ed25519.verify(signatureBytes,messageBytes,keyBytes.subarray(spkiPrefix.length),{zip215:false});}
    catch{return false;}
  }
}
