package io.github.vitafortis.octomodern

import io.github.vitafortis.octomodern.core.ServerAddress
import io.github.vitafortis.octomodern.core.ServerAddress.Parsed
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String): Parsed.Ok = ServerAddress.parse(input) as? Parsed.Ok ?: throw AssertionError("$input should be accepted: ${ServerAddress.parse(input)}")
    private fun invalid(input: String): String = (ServerAddress.parse(input) as? Parsed.Invalid ?: throw AssertionError("$input should be refused")).message

    @Test fun httpsAddressesBecomeOrigins() {
        assertEquals("https://print.armgrp.dev", ok("https://print.armgrp.dev").origin)
        assertEquals("https://print.armgrp.dev", ok("  https://Print.Armgrp.dev/  ").origin)
        assertEquals("https://print.armgrp.dev", ok("https://print.armgrp.dev/p/abc?x=1#y").origin)
        assertEquals("https://print.armgrp.dev:8443", ok("https://print.armgrp.dev:8443").origin)
        assertEquals("https://print.armgrp.dev", ok("https://print.armgrp.dev:443").origin)
        assertFalse(ok("https://print.armgrp.dev").insecure)
    }

    @Test fun noSchemeMeansHttps() {
        assertEquals("https://print.example.com", ok("print.example.com").origin)
        assertEquals("https://192.168.1.20:3000", ok("192.168.1.20:3000").origin)
    }

    @Test fun plainHttpOnlyOnPrivateNetworks() {
        for (a in listOf("http://192.168.1.20:3000", "http://10.0.2.2:5700", "http://172.16.0.5", "http://172.31.255.1", "http://127.0.0.1:3040", "http://100.101.102.103", "http://169.254.1.1", "http://octopi.local", "http://printers.lan", "http://nas.home.arpa:8080", "http://octo", "http://localhost:3040", "http://[fd00::12]:3000", "http://[fe80::1]", "http://[::1]")) {
            val p = ok(a)
            assertTrue("$a is insecure", p.insecure)
        }
        assertEquals("http://192.168.1.20:3000", ok("http://192.168.1.20:3000").origin)
        assertEquals("http://[fd00::12]:3000", ok("http://[fd00::12]:3000").origin)
        assertEquals("http://octopi.local", ok("http://octopi.local:80").origin)
        for (a in listOf("http://print.armgrp.dev", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.1.1", "http://[2001:db8::1]", "http://100.128.0.1", "http://example.local.evil.com")) {
            assertTrue(a, invalid(a).contains("https"))
        }
    }

    @Test fun refusesJunk() {
        invalid("")
        invalid("   ")
        invalid("ftp://print.example.com")
        invalid("javascript:alert(1)")
        invalid("https://user:pass@print.example.com")
        invalid("https://print example.com")
        invalid("https://")
        invalid("https://print.example.com:99999")
    }

    @Test fun sameOriginComparesSchemeHostAndPort() {
        val o = "https://print.armgrp.dev"
        assertTrue(ServerAddress.sameOrigin(o, "https://print.armgrp.dev/p/abc"))
        assertTrue(ServerAddress.sameOrigin(o, "https://PRINT.armgrp.dev:443/"))
        assertFalse(ServerAddress.sameOrigin(o, "http://print.armgrp.dev/"))
        assertFalse(ServerAddress.sameOrigin(o, "https://print.armgrp.dev:8443/"))
        assertFalse(ServerAddress.sameOrigin(o, "https://print.armgrp.dev.evil.com/"))
        assertFalse(ServerAddress.sameOrigin(o, "https://octopi.local/"))
        assertFalse(ServerAddress.sameOrigin(o, "not a url"))
        assertTrue(ServerAddress.sameOrigin("http://10.0.2.2:5700", "http://10.0.2.2:5700/login?next=/"))
    }

    @Test fun deepLinkPathsStayOnTheServer() {
        assertEquals("/p/abc", ServerAddress.safePath("/p/abc"))
        assertNull(ServerAddress.safePath("//evil.com/x"))
        assertNull(ServerAddress.safePath("https://evil.com"))
        assertNull(ServerAddress.safePath("/p/a b"))
        assertNull(ServerAddress.safePath(null))
    }
}
