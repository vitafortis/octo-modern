package io.github.vitafortis.octomodern

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import io.github.vitafortis.octomodern.data.SecretCipher
import io.github.vitafortis.octomodern.data.TokenStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

/** A reversible stand-in for the Keystore cipher (Robolectric has no AndroidKeyStore). */
private class FakeCipher : SecretCipher {
    var broken = false
    override fun encrypt(plain: ByteArray) = "sealed:" + Base64.getEncoder().encodeToString(plain.reversedArray())
    override fun decrypt(sealed: String): ByteArray {
        if (broken || !sealed.startsWith("sealed:")) throw IllegalStateException("key gone")
        return Base64.getDecoder().decode(sealed.removePrefix("sealed:")).reversedArray()
    }
}

@RunWith(RobolectricTestRunner::class)
class TokenStoreTest {
    private lateinit var cipher: FakeCipher
    private lateinit var store: TokenStore
    private val prefs get() = ApplicationProvider.getApplicationContext<Context>().getSharedPreferences("test-secrets", Context.MODE_PRIVATE)
    private val token = "ocd_" + "A".repeat(43)

    @Before fun setUp() {
        prefs.edit().clear().commit()
        cipher = FakeCipher()
        store = TokenStore(prefs, cipher)
    }

    @Test fun savesSealedAndReadsBack() {
        store.save("https://print.example.com", token, "dev-1")
        val raw = prefs.all.values.joinToString()
        assertFalse("the token isn't stored in the clear", raw.contains(token))
        val got = store.get("https://print.example.com")!!
        assertEquals(token, got.token)
        assertEquals("dev-1", got.deviceId)
    }

    @Test fun boundToItsServer() {
        store.save("https://print.example.com", token, null)
        assertNull(store.token("https://other.example.com"))
        assertNull(store.token("http://print.example.com"))
        assertEquals(token, store.token("https://print.example.com"))
    }

    @Test fun unreadableTokensAreDropped() {
        store.save("https://print.example.com", token, null)
        cipher.broken = true
        assertNull(store.get("https://print.example.com"))
        assertTrue("cleared", prefs.all.isEmpty())
    }

    @Test fun clearForgetsEverything() {
        store.save("https://print.example.com", token, "d")
        store.clear()
        assertNull(store.get("https://print.example.com"))
        assertTrue(prefs.all.isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun onlyDeviceTokens() {
        store.save("https://print.example.com", "ocm_status_token", null)
    }
}
