package sshcore

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/pem"
	"errors"
	"testing"

	"golang.org/x/crypto/ssh"
)

// makeKeys returns one private key of each supported type, in OpenSSH format.
func makeKeys(t *testing.T) map[string]any {
	t.Helper()

	_, ed, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("the Ed25519 key was not generated: %v", err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("the RSA key was not generated: %v", err)
	}
	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("the ECDSA key was not generated: %v", err)
	}
	return map[string]any{"ed25519": ed, "rsa": rsaKey, "ecdsa": ecKey}
}

func TestParseKeyAllTypes(t *testing.T) {
	for name, key := range makeKeys(t) {
		t.Run(name, func(t *testing.T) {
			block, err := ssh.MarshalPrivateKey(key, "test")
			if err != nil {
				t.Fatalf("the key was not written: %v", err)
			}
			signer, err := ParseKey(pem.EncodeToMemory(block), "")
			if err != nil {
				t.Fatalf("ParseKey failed: %v", err)
			}
			if signer.PublicKey() == nil {
				t.Fatal("the signer has no public key")
			}
		})
	}
}

func TestParseKeyWithPassphrase(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("the key was not generated: %v", err)
	}
	block, err := ssh.MarshalPrivateKeyWithPassphrase(key, "test", []byte("secret"))
	if err != nil {
		t.Fatalf("the key was not written: %v", err)
	}
	keyPEM := pem.EncodeToMemory(block)

	if _, err := ParseKey(keyPEM, "secret"); err != nil {
		t.Fatalf("the correct passphrase was refused: %v", err)
	}
	if _, err := ParseKey(keyPEM, ""); !errors.Is(err, ErrPassphraseRequired) {
		t.Fatalf("an empty passphrase gave %v, ErrPassphraseRequired was expected", err)
	}
	if _, err := ParseKey(keyPEM, "wrong"); !errors.Is(err, ErrPassphraseWrong) {
		t.Fatalf("a wrong passphrase gave %v, ErrPassphraseWrong was expected", err)
	}
}

// TestParseKeyIgnoresUnnecessaryPassphrase makes sure that a passphrase that
// the user typed for a plain key does not stop the login.
func TestParseKeyIgnoresUnnecessaryPassphrase(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("the key was not generated: %v", err)
	}
	block, err := ssh.MarshalPrivateKey(key, "test")
	if err != nil {
		t.Fatalf("the key was not written: %v", err)
	}
	if _, err := ParseKey(pem.EncodeToMemory(block), "not needed"); err != nil {
		t.Fatalf("ParseKey failed on a plain key: %v", err)
	}
}

func TestParseKeyRejectsRubbish(t *testing.T) {
	if _, err := ParseKey([]byte("this is not a key"), ""); err == nil {
		t.Fatal("ParseKey accepted text that is not a key")
	}
}
