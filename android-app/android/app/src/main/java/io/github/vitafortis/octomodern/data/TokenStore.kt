package io.github.vitafortis.octomodern.data

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts small secrets. The app uses [KeystoreCipher]; tests use a stand-in. */
interface SecretCipher {
    fun encrypt(plain: ByteArray): String
    fun decrypt(sealed: String): ByteArray
}

/**
 * AES-256-GCM with a key that lives in the Android Keystore (hardware-backed where the
 * phone has it) and never leaves it. Sealed values are `base64(iv) + "." + base64(ciphertext)`.
 * (EncryptedSharedPreferences does the same thing but is deprecated; this is the part of
 * it the app needs.)
 */
class KeystoreCipher(private val alias: String = "octomodern-device-token") : SecretCipher {
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun encrypt(plain: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.doFinal(plain)
        return Base64.encodeToString(c.iv, Base64.NO_WRAP) + "." + Base64.encodeToString(out, Base64.NO_WRAP)
    }

    override fun decrypt(sealed: String): ByteArray {
        val (iv, data) = sealed.split('.', limit = 2).let { it[0] to it[1] }
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        return c.doFinal(Base64.decode(data, Base64.NO_WRAP))
    }
}

/**
 * The device token (`ocd_…`) issued by the server after you sign in, sealed with
 * [SecretCipher] and bound to the server's origin: a token is never sent to another
 * server, and changing servers forgets it.
 */
class TokenStore(private val prefs: SharedPreferences, private val cipher: SecretCipher) {
    data class Stored(val origin: String, val token: String, val deviceId: String?)

    fun save(origin: String, token: String, deviceId: String?) {
        require(token.startsWith("ocd_")) { "not a device token" }
        prefs.edit()
            .putString(K_ORIGIN, origin)
            .putString(K_TOKEN, cipher.encrypt(token.toByteArray(Charsets.UTF_8)))
            .putString(K_DEVICE, deviceId)
            .apply()
    }

    /** The token for `origin`, or null (none, another server's, or unreadable — then it's dropped). */
    fun get(origin: String): Stored? {
        val o = prefs.getString(K_ORIGIN, null) ?: return null
        val sealed = prefs.getString(K_TOKEN, null) ?: return null
        if (o != origin) return null
        return try {
            Stored(o, String(cipher.decrypt(sealed), Charsets.UTF_8), prefs.getString(K_DEVICE, null))
        } catch (e: Exception) {
            // The keystore key is gone (restored backup, cleared lock screen…): sign in again.
            clear()
            null
        }
    }

    fun token(origin: String): String? = get(origin)?.token

    fun clear() {
        prefs.edit().remove(K_ORIGIN).remove(K_TOKEN).remove(K_DEVICE).apply()
    }

    companion object {
        const val PREFS = "octomodern.secrets"
        private const val K_ORIGIN = "origin"
        private const val K_TOKEN = "token"
        private const val K_DEVICE = "deviceId"
    }
}
