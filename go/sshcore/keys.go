// Package sshcore holds the SSH client logic of the browser SSH application.
//
// This package is pure Go. It does not import syscall/js and it never opens a
// network connection. The caller gives it a net.Conn that is already open. In
// the browser the connection comes from the Direct Sockets API. In the test it
// comes from net.Dial. The same code runs in both places.
package sshcore

import (
	"crypto/x509"
	"errors"
	"fmt"

	"golang.org/x/crypto/ssh"
)

// ErrPassphraseRequired says that the private key is encrypted and that the
// caller gave no passphrase. The user interface shows a passphrase field when
// it gets this error.
var ErrPassphraseRequired = errors.New("the private key is encrypted: a passphrase is necessary")

// ErrPassphraseWrong says that the passphrase did not decrypt the private key.
var ErrPassphraseWrong = errors.New("the passphrase is not correct")

// ParseKey reads an OpenSSH or PEM private key and returns a signer.
//
// RSA, Ed25519 and ECDSA keys are supported, because golang.org/x/crypto/ssh
// supports them. The passphrase can be empty. An empty passphrase with an
// encrypted key gives ErrPassphraseRequired.
func ParseKey(keyPEM []byte, passphrase string) (ssh.Signer, error) {
	// Always try the unencrypted path first. ParsePrivateKeyWithPassphrase
	// fails with "key is not password protected" on a plain key, so a
	// passphrase that the user typed for no reason must not break the login.
	signer, err := ssh.ParsePrivateKey(keyPEM)
	if err == nil {
		return signer, nil
	}

	var missing *ssh.PassphraseMissingError
	if !errors.As(err, &missing) {
		return nil, fmt.Errorf("the private key is not readable: %w", err)
	}

	if passphrase == "" {
		return nil, ErrPassphraseRequired
	}

	signer, err = ssh.ParsePrivateKeyWithPassphrase(keyPEM, []byte(passphrase))
	if err != nil {
		if errors.Is(err, x509.IncorrectPasswordError) {
			return nil, ErrPassphraseWrong
		}
		return nil, fmt.Errorf("the private key is not readable: %w", err)
	}
	return signer, nil
}
